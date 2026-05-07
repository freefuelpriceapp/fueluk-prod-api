'use strict';

/**
 * textractService.js
 * Wraps AWS Textract analyzeExpense to parse fuel receipts.
 * Images are processed in-memory — never persisted.
 *
 * Returns a structured receipt object or throws with partial data attached.
 */

const { TextractClient, AnalyzeExpenseCommand } = require('@aws-sdk/client-textract');
const { canonicalBrandName } = require('../utils/brandNormalizer');

const REGION = process.env.AWS_DEFAULT_REGION || 'us-east-1';

// Lazy singleton — only instantiated when first called
let _client = null;
function getClient() {
  if (!_client) {
    _client = new TextractClient({ region: REGION });
  }
  return _client;
}

// ─── Brand matcher ───────────────────────────────────────────────────────────
// Canonical UK fuel brands derived from govFuelData.js + extras
const UK_FUEL_BRANDS = [
  'Applegreen', 'Ascona', 'Asda', 'Asda Express', 'BP', 'Costco', 'Esso',
  'Gulf', 'Harvest Energy', 'Highland Fuels', 'Jet', 'Morrisons', 'Moto',
  'Motor Fuel Group', 'Murco', 'Nicholls', 'Rontec', 'SGN', 'Sainsburys',
  "Sainsbury's", 'Shell', 'Tesco', 'Texaco', 'Total',
];

/**
 * Given a raw vendor name string from Textract, attempt to match a canonical
 * UK fuel brand. Returns null if no match found.
 * Sorted by descending length so "Asda Express" is tried before "Asda".
 */
const UK_FUEL_BRANDS_SORTED = [...UK_FUEL_BRANDS].sort((a, b) => b.length - a.length);

function matchBrand(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
  // Try each brand, longest first, so "Asda Express" beats "Asda"
  for (const brand of UK_FUEL_BRANDS_SORTED) {
    const brandUpper = brand.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
    if (upper.includes(brandUpper)) {
      return brand;
    }
  }
  // Reverse: does the raw name appear inside a brand name?
  // Only if the raw name is at least 3 chars to avoid false positives
  if (upper.trim().length >= 3) {
    for (const brand of UK_FUEL_BRANDS_SORTED) {
      const brandUpper = brand.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
      if (brandUpper.includes(upper.trim()) && upper.trim().length >= 3) {
        return brand;
      }
    }
  }
  return null;
}

// ─── Fuel type resolver ───────────────────────────────────────────────────────
const FUEL_TYPE_PATTERNS = [
  { regex: /\bPREMIUM\s+DIESEL\b|\bULTIMATE\s+DIESEL\b|\bV-POWER\s+DIESEL\b/i, type: 'premium_diesel' },
  { regex: /\bSUPER\s*UNLEADED\b|\bSUPREME\b|\bV-POWER\b|\bULTIMATES\b|\bMOMENTUM\b/i, type: 'super_unleaded' },
  { regex: /\bDIESEL\b|\bB7\b|\bGASOIL\b/i, type: 'diesel' },
  { regex: /\bUNLEADED\b|\bE10\b|\bE5\b|\bPETROL\b|\bGASP\b/i, type: 'unleaded' },
];

function resolveFuelType(text) {
  if (!text) return null;
  const upper = text.toUpperCase();
  for (const { regex, type } of FUEL_TYPE_PATTERNS) {
    if (regex.test(upper)) return type;
  }
  return null;
}

// ─── Price parsing helpers ────────────────────────────────────────────────────
/**
 * Parse a price string to a float. Handles formats like:
 *   "152.9", "£38.42", "3874", "38.42"
 */
function parsePrice(str) {
  if (str == null) return null;
  const cleaned = String(str).replace(/[£$,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert a raw total amount to pence. Total on a fuel receipt is in £ (e.g. 58.74).
 * If the value looks like it's already in pence (> 1000 for a petrol fill), keep it.
 * Heuristic: if > 500 → assume pence; else assume pounds → multiply by 100.
 */
function toPence(value) {
  if (value == null) return null;
  // Values > 500 are plausibly already pence (£5+ would be min reasonable fill)
  if (value > 500) return Math.round(value);
  return Math.round(value * 100);
}

/**
 * Parse a date string from Textract. Returns ISO 8601 date string or null.
 */
function parseDate(str) {
  if (!str) return null;
  // Common UK date formats: dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd
  const cleaned = str.trim();
  // Try ISO first
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
  // dd/mm/yyyy or dd-mm-yyyy
  const m = cleaned.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Fallback: try native Date parsing
  const dt = new Date(cleaned);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

// ─── Textract response parser ─────────────────────────────────────────────────

/**
 * Parse an AnalyzeExpense response from Textract into structured receipt data.
 * Returns { data, confidence, partial }
 */
function parseTextractResponse(response) {
  const docs = response.ExpenseDocuments || [];
  if (!docs.length) return { data: {}, confidence: 0, partial: true };

  const doc = docs[0];
  const summaryFields = doc.SummaryFields || [];
  const lineItems = (doc.LineItemGroups || []).flatMap((g) => g.LineItems || []);

  let totalConfidence = 0;
  let confidenceCount = 0;

  function trackConf(field) {
    if (field && field.ValueDetection && field.ValueDetection.Confidence != null) {
      totalConfidence += field.ValueDetection.Confidence;
      confidenceCount += 1;
    }
  }

  // Helper to find a summary field by type
  function findField(type) {
    return summaryFields.find((f) => f.Type && f.Type.Text === type);
  }

  function fieldValue(type) {
    const f = findField(type);
    if (!f) return null;
    trackConf(f);
    return f.ValueDetection ? f.ValueDetection.Text : null;
  }

  // Vendor / station name
  const vendorRaw = fieldValue('VENDOR_NAME') || fieldValue('NAME');
  const stationName = vendorRaw ? vendorRaw.toUpperCase() : null;
  const stationBrand = matchBrand(vendorRaw);

  // Total
  const totalRaw = fieldValue('TOTAL') || fieldValue('AMOUNT_PAID') || fieldValue('SUBTOTAL');
  const totalParsed = parsePrice(totalRaw);
  const totalPaid = totalParsed != null ? toPence(totalParsed) : null;

  // Date
  const dateRaw = fieldValue('INVOICE_RECEIPT_DATE') || fieldValue('ORDER_DATE') || fieldValue('DATE');
  const receiptDate = parseDate(dateRaw);

  // ─── Line items: look for fuel type, litres, p/L ─────────────────────────
  let fuelType = null;
  let litres = null;
  let pricePerLitre = null;

  for (const item of lineItems) {
    const itemFields = item.LineItemExpenseFields || [];

    let itemDesc = null;
    let itemQty = null;
    let itemUnit = null;
    let itemUnitPrice = null;
    let itemPrice = null;

    for (const f of itemFields) {
      trackConf(f);
      const type = f.Type ? f.Type.Text : null;
      const val = f.ValueDetection ? f.ValueDetection.Text : null;
      if (!type || !val) continue;
      switch (type) {
        case 'ITEM': itemDesc = val; break;
        case 'QUANTITY': itemQty = parsePrice(val); break;
        case 'UNIT': itemUnit = val; break;
        case 'UNIT_PRICE': itemUnitPrice = parsePrice(val); break;
        case 'PRICE': itemPrice = parsePrice(val); break;
      }
    }

    // Attempt to resolve fuel type from description
    const resolvedType = resolveFuelType(itemDesc);
    if (resolvedType && !fuelType) {
      fuelType = resolvedType;

      // Litres: look for qty or unit
      if (itemQty != null && itemQty > 0) {
        litres = Math.round(itemQty * 100) / 100;
      }

      // Price per litre: unit price (in pence/L format: 152.9) or derive
      if (itemUnitPrice != null && itemUnitPrice > 0) {
        // If unit price looks like pence/L (50–300 range), use directly
        if (itemUnitPrice >= 50 && itemUnitPrice <= 300) {
          pricePerLitre = Math.round(itemUnitPrice * 10) / 10;
        } else if (itemUnitPrice < 5) {
          // Looks like £/L — convert to pence
          pricePerLitre = Math.round(itemUnitPrice * 100 * 10) / 10;
        }
      }
    }
  }

  // ─── If fuel type not found in line items, scan summary fields ────────────
  if (!fuelType) {
    for (const f of summaryFields) {
      const text = (f.ValueDetection ? f.ValueDetection.Text : '') || '';
      const labelText = (f.Type ? f.Type.Text : '') || '';
      const combined = `${labelText} ${text}`;
      const resolved = resolveFuelType(combined);
      if (resolved) { fuelType = resolved; break; }
    }
  }

  // ─── Derivations ─────────────────────────────────────────────────────────
  // Derive pricePerLitre if we have totalPaid + litres
  if (pricePerLitre == null && totalPaid != null && litres != null && litres > 0) {
    pricePerLitre = Math.round(((totalPaid / litres)) * 10) / 10;
  }
  // Derive litres if we have totalPaid + pricePerLitre
  if (litres == null && totalPaid != null && pricePerLitre != null && pricePerLitre > 0) {
    litres = Math.round((totalPaid / pricePerLitre) * 100) / 100;
  }

  const ocrConfidence = confidenceCount > 0
    ? Math.round((totalConfidence / confidenceCount / 100) * 100) / 100
    : 0;

  const data = {
    stationName: stationName || undefined,
    stationBrand: stationBrand || undefined,
    fuelType: fuelType || undefined,
    litres: litres != null ? litres : undefined,
    pricePerLitre: pricePerLitre != null ? pricePerLitre : undefined,
    totalPaid: totalPaid != null ? totalPaid : undefined,
    receiptDate: receiptDate || undefined,
    ocrConfidence,
  };

  // Check if we have the minimum required fields
  const hasMinimum = data.totalPaid != null || data.litres != null || data.pricePerLitre != null;

  return { data, confidence: ocrConfidence, partial: !hasMinimum };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze a fuel receipt image using AWS Textract analyzeExpense.
 *
 * @param {Buffer} imageBuffer — image bytes (JPEG or PNG)
 * @returns {Promise<{stationName, stationBrand, fuelType, litres, pricePerLitre, totalPaid, receiptDate, ocrConfidence}>}
 * @throws {Error} with .partial containing whatever was parsed, or .isServiceError for Textract 5xx
 */
async function analyzeReceiptImage(imageBuffer) {
  const client = getClient();

  let response;
  try {
    const command = new AnalyzeExpenseCommand({
      Document: { Bytes: imageBuffer },
    });
    response = await client.send(command);
  } catch (err) {
    // Distinguish Textract service errors from everything else
    const msg = err.message || '';
    if (
      err.$metadata?.httpStatusCode >= 500 ||
      msg.includes('ServiceUnavailable') ||
      msg.includes('ThrottlingException') ||
      msg.includes('InternalServerError')
    ) {
      const e = new Error('Textract service unavailable');
      e.isServiceError = true;
      throw e;
    }
    // Invalid image format, etc.
    const e = new Error(`Textract analyzeExpense failed: ${msg}`);
    e.partial = {};
    throw e;
  }

  const { data, partial } = parseTextractResponse(response);

  // Ops telemetry log — no image content, no PII
  console.info(JSON.stringify({
    level: 'info',
    event: 'ocr_result',
    confidence: data.ocrConfidence,
    brand_matched: Boolean(data.stationBrand),
    fuelType_resolved: data.fuelType || null,
  }));

  if (partial || data.ocrConfidence < 0.1) {
    const e = new Error('OCR produced insufficient data');
    e.partial = data;
    throw e;
  }

  return data;
}

module.exports = {
  analyzeReceiptImage,
  matchBrand,
  resolveFuelType,
  parseDate,
  parseTextractResponse,
  _setClientForTests: (c) => { _client = c; },
};

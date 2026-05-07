'use strict';

/**
 * receipts.js
 * POST /api/v1/receipts/ocr          — anonymous, multipart, Textract OCR
 * POST /api/v1/receipts/groundtruth  — anonymous, JSON, opt-in ground-truth feed
 *
 * Both endpoints are unauthenticated (no device ID stored, no IP stored).
 * Rate limits are enforced per hashed X-Device-ID or fallback hashed IP.
 */

const router = require('express').Router();
const multer = require('multer');
const crypto = require('crypto');
const textractService = require('../services/textractService');
const groundtruthRepo = require('../repositories/groundtruthRepository');

// ─── Multer (memory storage — image never touches disk) ───────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter(req, file, cb) {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      const err = new Error('Only JPEG and PNG images are accepted');
      err.code = 'INVALID_MIME';
      cb(err);
    }
  },
});

// ─── In-memory LRU-ish rate limiter ──────────────────────────────────────────
// Simple window map: key → { count, resetAt }
const _ocrStore = new Map();
const _gtStore = new Map();

// Cleanup stale windows every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _ocrStore) { if (v.resetAt < now) _ocrStore.delete(k); }
  for (const [k, v] of _gtStore) { if (v.resetAt < now) _gtStore.delete(k); }
}, 5 * 60 * 1000).unref();

function checkRateLimit(store, key, max, windowMs) {
  const now = Date.now();
  const record = store.get(key);
  if (!record || record.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  record.count += 1;
  if (record.count > max) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((record.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfter: 0 };
}

function getRateLimitKey(req) {
  const raw = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'].trim() : '';
  if (raw) {
    return 'dev:' + crypto.createHash('sha256').update(raw).digest('hex');
  }
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  return 'ip:' + crypto.createHash('sha256').update(String(ip)).digest('hex');
}

const OCR_MAX = 5;
const OCR_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const GT_MAX = 10;
const GT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ─── Canonical UK fuel brand validation set ───────────────────────────────────
const VALID_BRANDS = new Set([
  'Applegreen', 'Ascona', 'Asda', 'Asda Express', 'BP', 'Costco', 'Esso',
  'Gulf', 'Harvest Energy', 'Highland Fuels', 'Jet', 'Morrisons', 'Moto',
  'Motor Fuel Group', 'Murco', 'Nicholls', 'Rontec', 'SGN', 'Sainsburys',
  "Sainsbury's", 'Shell', 'Tesco', 'Texaco', 'Total',
]);

const VALID_FUEL_TYPES = new Set(['unleaded', 'super_unleaded', 'diesel', 'premium_diesel']);

// Outcode only: 1-2 letters + digit(s) — NO inner code (space + digit/letter)
const OUTCODE_RE = /^[A-Z]{1,2}[0-9R][0-9A-Z]?$/;
// Full postcode detection: contains a space or has 6-7 chars that look like full postcode
const FULL_POSTCODE_RE = /^[A-Z]{1,2}[0-9R][0-9A-Z]?\s[0-9][A-Z]{2}$/;

// ─── POST /receipts/ocr ───────────────────────────────────────────────────────
router.post(
  '/ocr',
  (req, res, next) => {
    // Rate limit check before multer so we don't parse the image if limited
    const key = getRateLimitKey(req);
    const result = checkRateLimit(_ocrStore, key, OCR_MAX, OCR_WINDOW_MS);
    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter);
      return res.status(429).json({
        error: 'rate_limited',
        message: `OCR rate limit: ${OCR_MAX} calls per hour. Retry in ${result.retryAfter}s.`,
        retry_after_seconds: result.retryAfter,
      });
    }
    next();
  },
  (req, res, next) => {
    upload.single('image')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'image_too_large', message: 'Image must be ≤ 8 MB' });
        }
        if (err.code === 'INVALID_MIME') {
          return res.status(422).json({ error: 'invalid_image', message: err.message });
        }
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    if (!req.file) {
      return res.status(422).json({ error: 'missing_image', message: 'Field "image" is required (JPEG or PNG)' });
    }

    try {
      const result = await textractService.analyzeReceiptImage(req.file.buffer);
      // Drop buffer immediately — never persisted
      req.file.buffer = null;
      return res.status(200).json(result);
    } catch (err) {
      // Drop buffer on error too
      if (req.file) req.file.buffer = null;

      if (err.isServiceError) {
        return res.status(503).json({ error: 'textract_unavailable', message: 'OCR service temporarily unavailable' });
      }
      if (err.partial !== undefined) {
        return res.status(422).json({
          error: 'ocr_failed',
          message: err.message || 'Could not extract receipt data',
          partial: err.partial,
        });
      }
      return next(err);
    }
  }
);

// ─── POST /receipts/groundtruth ───────────────────────────────────────────────
router.post('/groundtruth', async (req, res, next) => {
  // Rate limit
  const key = getRateLimitKey(req);
  const rl = checkRateLimit(_gtStore, key, GT_MAX, GT_WINDOW_MS);
  if (!rl.allowed) {
    res.setHeader('Retry-After', rl.retryAfter);
    return res.status(429).json({
      error: 'rate_limited',
      message: `Ground-truth rate limit: ${GT_MAX} calls per hour. Retry in ${rl.retryAfter}s.`,
      retry_after_seconds: rl.retryAfter,
    });
  }

  try {
    const { brand, postcode_outcode, p_per_l, fuel_type, receipt_date } = req.body || {};

    // ─ Validation ─
    const errors = [];

    // brand
    if (!brand) {
      errors.push({ field: 'brand', message: 'required' });
    } else if (!VALID_BRANDS.has(brand)) {
      errors.push({ field: 'brand', message: `Unknown brand "${brand}". Must be a canonical UK fuel brand.` });
    }

    // postcode_outcode — reject full postcodes
    if (!postcode_outcode) {
      errors.push({ field: 'postcode_outcode', message: 'required' });
    } else {
      const upper = String(postcode_outcode).toUpperCase().trim();
      if (FULL_POSTCODE_RE.test(upper) || upper.includes(' ')) {
        errors.push({ field: 'postcode_outcode', message: 'Full postcodes are not accepted — outcode only (e.g. "B10", "SW1")' });
      } else if (!OUTCODE_RE.test(upper)) {
        errors.push({ field: 'postcode_outcode', message: `Invalid outcode format. Expected e.g. "B10", "SW1A", "M1"` });
      }
    }

    // p_per_l
    if (p_per_l == null) {
      errors.push({ field: 'p_per_l', message: 'required' });
    } else {
      const n = Number(p_per_l);
      if (!Number.isFinite(n) || n < 80 || n > 300) {
        errors.push({ field: 'p_per_l', message: 'Must be between 80 and 300 pence/litre' });
      }
    }

    // fuel_type
    if (!fuel_type) {
      errors.push({ field: 'fuel_type', message: 'required' });
    } else if (!VALID_FUEL_TYPES.has(fuel_type)) {
      errors.push({ field: 'fuel_type', message: `Must be one of: ${[...VALID_FUEL_TYPES].join(', ')}` });
    }

    // receipt_date — ISO 8601, within last 30 days
    if (!receipt_date) {
      errors.push({ field: 'receipt_date', message: 'required' });
    } else {
      const dt = new Date(receipt_date);
      if (isNaN(dt.getTime())) {
        errors.push({ field: 'receipt_date', message: 'Must be a valid ISO 8601 date (e.g. "2026-05-07")' });
      } else {
        const now = new Date();
        const diffDays = (now - dt) / (1000 * 60 * 60 * 24);
        if (diffDays < 0) {
          errors.push({ field: 'receipt_date', message: 'Receipt date cannot be in the future' });
        } else if (diffDays > 30) {
          errors.push({ field: 'receipt_date', message: 'Receipt date must be within the last 30 days' });
        }
      }
    }

    if (errors.length) {
      return res.status(400).json({ error: 'validation_failed', errors });
    }

    // ─ Store ─
    await groundtruthRepo.insertGroundTruth({
      brand,
      postcode_outcode: String(postcode_outcode).toUpperCase().trim(),
      p_per_l: Number(p_per_l),
      fuel_type,
      receipt_date,
    });

    // Ops telemetry — no PII
    console.info(JSON.stringify({
      level: 'info',
      event: 'groundtruth_ingested',
      brand,
      outcode: String(postcode_outcode).toUpperCase().trim(),
      fuel_type,
    }));

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// Export for test access to rate-limit stores
module.exports = router;
module.exports._ocrStore = _ocrStore;
module.exports._gtStore = _gtStore;
module.exports._resetOcrStore = () => _ocrStore.clear();
module.exports._resetGtStore = () => _gtStore.clear();
module.exports.VALID_BRANDS = VALID_BRANDS;
module.exports.OUTCODE_RE = OUTCODE_RE;

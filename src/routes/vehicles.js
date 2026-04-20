'use strict';
const router = require('express').Router();

/**
 * Sprint 2 — Vehicle lookup by UK registration plate.
 * GET /api/v1/vehicles/lookup?reg=AB12CDE
 *
 * Primary source: DVLA Vehicle Enquiry Service (VES) — requires an API key
 * in DVLA_API_KEY. If not configured, we fall back to a small lookup table
 * of common UK vehicles keyed off the plate's age identifier so the mobile
 * app still gets a sensible response for beta testing.
 */

const DVLA_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';

// Minimal fallback: loose inference from UK plate age identifier.
// UK plates use AB12 CDE — the two digits are the age identifier.
// Period 1 (Mar–Aug) uses the year (e.g. 24 = 2024).
// Period 2 (Sep–Feb) uses year + 50 (e.g. 74 = 2024).
function yearFromAgeIdentifier(ageDigits) {
  const n = parseInt(ageDigits, 10);
  if (!Number.isFinite(n)) return null;
  if (n >= 1 && n <= 50) return 2000 + n;
  if (n >= 51 && n <= 99) return 2000 + (n - 50);
  return null;
}

function normaliseReg(reg) {
  if (!reg) return null;
  const cleaned = String(reg).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Build a plausible-looking mock vehicle for beta / dev when the DVLA key
 * isn't configured. This is clearly flagged as mocked in the response so
 * the mobile client can decide whether to show a "verified by DVLA" badge.
 */
function mockVehicleFor(reg) {
  // Pull out age identifier (chars 3-4 in modern format AB12CDE) if present.
  const ageDigits = reg.length >= 4 ? reg.slice(2, 4) : '';
  const year = yearFromAgeIdentifier(ageDigits) || 2020;

  // Tiny sample of common UK cars keyed off a cheap hash of the plate so
  // the same plate returns the same mock consistently.
  const SAMPLES = [
    { make: 'FORD', model: 'FIESTA', fuel_type: 'PETROL', engine_cc: 1084, co2_emissions: 110, estimated_mpg: 55 },
    { make: 'VOLKSWAGEN', model: 'GOLF', fuel_type: 'DIESEL', engine_cc: 1968, co2_emissions: 120, estimated_mpg: 58 },
    { make: 'VAUXHALL', model: 'CORSA', fuel_type: 'PETROL', engine_cc: 1199, co2_emissions: 108, estimated_mpg: 52 },
    { make: 'BMW', model: '320D', fuel_type: 'DIESEL', engine_cc: 1995, co2_emissions: 130, estimated_mpg: 54 },
    { make: 'TOYOTA', model: 'COROLLA', fuel_type: 'HYBRID ELECTRIC', engine_cc: 1798, co2_emissions: 85, estimated_mpg: 65 },
    { make: 'NISSAN', model: 'QASHQAI', fuel_type: 'PETROL', engine_cc: 1332, co2_emissions: 128, estimated_mpg: 45 },
  ];
  let hash = 0;
  for (let i = 0; i < reg.length; i++) hash = (hash * 31 + reg.charCodeAt(i)) >>> 0;
  const pick = SAMPLES[hash % SAMPLES.length];

  return {
    registration: reg,
    make: pick.make,
    model: pick.model,
    fuel_type: pick.fuel_type,
    engine_cc: pick.engine_cc,
    co2_emissions: pick.co2_emissions,
    year,
    estimated_mpg: pick.estimated_mpg,
    source: 'mock',
  };
}

/**
 * Rough MPG estimate based on engine size and fuel type. Used when DVLA
 * returns details but no MPG (it never does — MPG isn't in the VES feed).
 */
function estimateMpg(fuelType, engineCc) {
  const ft = (fuelType || '').toUpperCase();
  const cc = Number(engineCc) || 1600;
  if (ft.includes('ELECTRIC') && !ft.includes('HYBRID')) return 0; // no ICE
  if (ft.includes('HYBRID')) return 60;
  if (ft.includes('DIESEL')) {
    if (cc < 1600) return 60;
    if (cc < 2000) return 55;
    if (cc < 2500) return 48;
    return 40;
  }
  // Petrol-ish default
  if (cc < 1200) return 55;
  if (cc < 1600) return 48;
  if (cc < 2000) return 42;
  if (cc < 2500) return 35;
  return 28;
}

async function fetchFromDvla(reg, apiKey) {
  const res = await fetch(DVLA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ registrationNumber: reg }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`DVLA API ${res.status}: ${bodyText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

router.get('/lookup', async (req, res, next) => {
  try {
    const reg = normaliseReg(req.query.reg);
    if (!reg) {
      return res.status(400).json({ error: 'reg query param is required (valid UK plate, letters/digits only)' });
    }

    const apiKey = process.env.DVLA_API_KEY;
    if (apiKey) {
      try {
        const data = await fetchFromDvla(reg, apiKey);
        const engineCc = data.engineCapacity || null;
        return res.json({
          registration: data.registrationNumber || reg,
          make: data.make || null,
          model: data.model || null,
          fuel_type: data.fuelType || null,
          engine_cc: engineCc,
          co2_emissions: data.co2Emissions || null,
          year: data.yearOfManufacture || null,
          estimated_mpg: estimateMpg(data.fuelType, engineCc),
          source: 'dvla',
        });
      } catch (err) {
        // 404 from DVLA means the plate isn't on record — surface that
        // directly rather than falling back to a mock, which would lie.
        if (err.status === 404) {
          return res.status(404).json({ error: 'Vehicle not found on DVLA register', registration: reg });
        }
        console.error('[Vehicles] DVLA lookup failed, falling back to mock:', err.message);
      }
    }

    // No API key configured, or DVLA non-404 error: return a mock so the
    // mobile flow works in dev and during beta before the key lands.
    return res.json(mockVehicleFor(reg));
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.normaliseReg = normaliseReg;
module.exports.estimateMpg = estimateMpg;
module.exports.yearFromAgeIdentifier = yearFromAgeIdentifier;

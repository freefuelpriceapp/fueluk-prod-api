'use strict';
const router = require('express').Router();

/**
 * Vehicle lookup by UK registration plate.
 * GET /api/v1/vehicles/lookup?reg=AB12CDE[&refresh=true]
 *
 * Combines DVLA Vehicle Enquiry Service (tax/MOT status, make/model, etc.)
 * with DVSA MOT History (full test history, defects, mileage). Each source
 * is fetched in parallel and degrades gracefully — a missing API key or
 * upstream error still returns whatever data the other source provided.
 *
 * If neither API is configured we fall back to a deterministic mock so the
 * mobile flow keeps working in dev / early beta. The response explicitly
 * labels mock data via `source: 'mock'` so clients can suppress "verified"
 * UI badges.
 *
 * Results are cached for 24h keyed by normalised reg; clients can force a
 * refresh with `?refresh=true`.
 */

const vehicleCheckService = require('../services/vehicleCheckService');
const dvlaService = require('../services/dvlaService');
const dvsaService = require('../services/dvsaService');
const { vehicleLimiter } = require('../middleware/vehicleRateLimit');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_ENTRIES = 1000;

const cache = new Map(); // reg -> { value, expiresAt }

function cacheGet(reg) {
  const entry = cache.get(reg);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(reg);
    return null;
  }
  return entry.value;
}

function cacheSet(reg, value) {
  if (cache.has(reg)) cache.delete(reg);
  cache.set(reg, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function clearCache() { cache.clear(); }

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
  const cleaned = String(reg).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(cleaned)) return null;
  // Reject "obviously invalid" plates — must contain at least one letter
  // and at least one digit to be a real UK reg (ruling out "12345" etc.).
  if (!/[A-Z]/.test(cleaned) || !/\d/.test(cleaned)) return null;
  return cleaned;
}

function estimateMpg(fuelType, engineCc) {
  const ft = (fuelType || '').toUpperCase();
  const cc = Number(engineCc) || 1600;
  if (ft.includes('ELECTRIC') && !ft.includes('HYBRID')) return 0;
  if (ft.includes('HYBRID')) return 60;
  if (ft.includes('DIESEL')) {
    if (cc < 1600) return 60;
    if (cc < 2000) return 55;
    if (cc < 2500) return 48;
    return 40;
  }
  if (cc < 1200) return 55;
  if (cc < 1600) return 48;
  if (cc < 2000) return 42;
  if (cc < 2500) return 35;
  return 28;
}

function mockVehicleFor(reg) {
  const ageDigits = reg.length >= 4 ? reg.slice(2, 4) : '';
  const year = yearFromAgeIdentifier(ageDigits) || 2020;

  const SAMPLES = [
    { make: 'FORD', model: 'FIESTA', fuelType: 'PETROL', engineCapacity: 1084, co2Emissions: 110 },
    { make: 'VOLKSWAGEN', model: 'GOLF', fuelType: 'DIESEL', engineCapacity: 1968, co2Emissions: 120 },
    { make: 'VAUXHALL', model: 'CORSA', fuelType: 'PETROL', engineCapacity: 1199, co2Emissions: 108 },
    { make: 'BMW', model: '320D', fuelType: 'DIESEL', engineCapacity: 1995, co2Emissions: 130 },
    { make: 'TOYOTA', model: 'COROLLA', fuelType: 'HYBRID ELECTRIC', engineCapacity: 1798, co2Emissions: 85 },
    { make: 'NISSAN', model: 'QASHQAI', fuelType: 'PETROL', engineCapacity: 1332, co2Emissions: 128 },
  ];
  let hash = 0;
  for (let i = 0; i < reg.length; i++) hash = (hash * 31 + reg.charCodeAt(i)) >>> 0;
  const pick = SAMPLES[hash % SAMPLES.length];

  return {
    registration: reg,
    make: pick.make,
    model: pick.model,
    colour: null,
    yearOfManufacture: year,
    fuelType: pick.fuelType,
    engineCapacity: pick.engineCapacity,
    co2Emissions: pick.co2Emissions,
    taxStatus: null,
    taxDueDate: null,
    motStatus: null,
    motExpiryDate: null,
    insuranceStatus: 'unavailable',
    dvlaAvailable: false,
    motHistoryAvailable: false,
    motHistory: [],
    estimated_mpg: estimateMpg(pick.fuelType, pick.engineCapacity),
    source: 'mock',
    checkedAt: new Date().toISOString(),
    sources: {
      dvla: { available: false, error: 'DVLA_API_KEY not configured' },
      mot: { available: false, error: 'DVSA_MOT_API_KEY not configured' },
      insurance: { available: false, error: 'askMID insurance check not yet configured' },
    },
  };
}

const INSURANCE_CHECK_METADATA = {
  provider: 'MIB Navigate',
  url: 'https://enquiry.navigate.mib.org.uk/checkyourvehicle',
  description: 'Check if your vehicle is showing as insured on the Motor Insurance Database',
  checkTypes: [
    {
      type: 'personal',
      label: 'Personal check',
      description: 'Vehicle is owned, registered, or insured by you or your employer',
    },
    {
      type: 'third_party',
      label: 'Third party check',
      description: 'Vehicle is owned or insured by someone else',
    },
  ],
  terms: "You must live in the UK. You can only check vehicles registered, owned, or insured by you/your employer, or that you're allowed to drive. It's an offence to check otherwise.",
  disclaimer: 'It may take 7 days or more for new policies to appear. This check is not proof of insurance status.',
  contactUrl: 'https://enquiry.navigate.mib.org.uk/contact-us',
};

router.get('/insurance-check', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.json(INSURANCE_CHECK_METADATA);
});

router.get('/lookup', vehicleLimiter, async (req, res, next) => {
  try {
    const reg = normaliseReg(req.query.reg);
    if (!reg) {
      return res.status(400).json({
        error: 'reg query param is required (valid UK plate: letters and digits, 2–8 chars after stripping spaces)',
      });
    }

    const refresh = req.query.refresh === 'true' || req.query.refresh === '1';

    if (!refresh) {
      const cached = cacheGet(reg);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
    }
    res.setHeader('X-Cache', refresh ? 'BYPASS' : 'MISS');

    // No keys configured at all → mock fallback for dev/beta.
    if (!dvlaService.isConfigured() && !dvsaService.isConfigured()) {
      const mock = mockVehicleFor(reg);
      return res.json(mock);
    }

    const { response } = await vehicleCheckService.lookupVehicle(reg);

    // If DVLA explicitly said the plate doesn't exist, surface 404 rather
    // than returning an empty "success" payload.
    if (response.sources.dvla.notFound && !response.motHistoryAvailable) {
      return res.status(404).json({ error: 'Vehicle not found on DVLA register', registration: reg });
    }

    // Enrich with our MPG estimate (not provided by DVLA VES).
    response.estimated_mpg = estimateMpg(response.fuelType, response.engineCapacity);

    cacheSet(reg, response);
    return res.json(response);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.normaliseReg = normaliseReg;
module.exports.estimateMpg = estimateMpg;
module.exports.yearFromAgeIdentifier = yearFromAgeIdentifier;
module.exports.mockVehicleFor = mockVehicleFor;
module.exports.clearCache = clearCache;
module.exports._cache = cache;
module.exports.INSURANCE_CHECK_METADATA = INSURANCE_CHECK_METADATA;

'use strict';

/**
 * vehicleCheckService.js
 * Orchestrates DVLA + DVSA MOT lookups and merges them into the unified
 * vehicle response the mobile app expects. Each source is fetched in
 * parallel so a slow DVSA response doesn't block DVLA and vice versa.
 *
 * Graceful degradation: a missing key or upstream error surfaces in
 * `sources[<name>].error` and the matching `<name>Available` flag, but
 * never fails the request outright — the caller still gets whatever
 * data we could collect.
 */

const dvlaService = require('./dvlaService');
const dvsaService = require('./dvsaService');
const vehicleSpecService = require('./vehicleSpecService');

function mapMotHistory(raw) {
  if (!raw) return [];
  // DVSA returns an array of vehicles (usually 1); each has motTests[].
  const vehicle = Array.isArray(raw) ? raw[0] : raw;
  const tests = vehicle?.motTests || [];
  return tests.map((t) => ({
    testDate: t.completedDate || null,
    result: t.testResult || null,
    mileage: t.odometerValue != null ? Number(t.odometerValue) : null,
    mileageUnit: t.odometerUnit || null,
    expiryDate: t.expiryDate || null,
    motTestNumber: t.motTestNumber || null,
    defects: Array.isArray(t.defects)
      ? t.defects.map((d) => ({
          text: d.text || null,
          type: d.type || null,
          dangerous: Boolean(d.dangerous),
        }))
      : [],
  }));
}

// Promoted spec keys — always present on the response, null when enrichment
// is disabled or upstream couldn't supply a value. This keeps the schema
// stable for the mobile client regardless of upstream availability.
const SPEC_KEYS_DEFAULT = Object.freeze({
  trim: null,
  variant: null,
  transmission: null,
  doors: null,
  body_style: null,
  engine_capacity_cc: null,
  fuel_type_detailed: null,
  model_full: null,
});

function _deriveSpecSource(spec, flagEnabled) {
  if (spec) return 'checkcardetails';
  if (!flagEnabled) return 'dvla_only';
  return 'unavailable';
}

function _flattenSpecFields(spec, dvla) {
  if (!spec) {
    return {
      ...SPEC_KEYS_DEFAULT,
      // Even without enrichment, fall back to whatever DVLA gave us so the
      // engine_capacity_cc field is consistently populated when possible.
      engine_capacity_cc: dvla?.engineCapacity || null,
    };
  }
  return {
    trim: spec.trim || null,
    variant: spec.variant || null,
    transmission: spec.transmission || null,
    doors: spec.doors == null ? null : spec.doors,
    body_style: spec.bodyStyle || null,
    engine_capacity_cc: dvla?.engineCapacity || null,
    fuel_type_detailed: spec.fuelDescription || null,
    model_full: spec.derivative || spec.variant || spec.model || null,
  };
}

function pickLatestTest(motHistory) {
  if (!Array.isArray(motHistory) || !motHistory.length) return null;
  let latest = null;
  let latestMs = -Infinity;
  for (const t of motHistory) {
    if (!t || !t.testDate) continue;
    const ms = Date.parse(t.testDate);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = t;
    }
  }
  return latest;
}

/**
 * Build the standard mot_* schema fields. These are ALWAYS present on the
 * /lookup response (null when unavailable). Wave B.1 contract.
 */
function buildMotSchema(motResult, motHistory) {
  const motHasData = Boolean(motResult?.available) && !motResult?.notFound;
  if (!motHasData) {
    return {
      mot_status: null,
      mot_expiry_date: null,
      mot_last_test_date: null,
      mot_last_test_result: null,
      mot_advisories: [],
      mot_defects: [],
      mot_test_count: 0,
      mot_odometer_at_last_test: null,
      mot_source: 'unavailable',
    };
  }

  const latest = pickLatestTest(motHistory) || null;
  const expiry = latest && latest.expiryDate ? latest.expiryDate : null;
  let status = 'no_results';
  if (expiry) {
    const expMs = Date.parse(expiry);
    if (Number.isFinite(expMs)) {
      status = expMs >= Date.now() ? 'valid' : 'expired';
    }
  }

  const defects = Array.isArray(latest?.defects) ? latest.defects : [];
  const advisoryStrings = defects
    .filter((d) => String(d.type || '').toUpperCase() === 'ADVISORY')
    .map((d) => d.text)
    .filter(Boolean);
  const defectStrings = defects
    .filter((d) => {
      const t = String(d.type || '').toUpperCase();
      return t && t !== 'ADVISORY';
    })
    .map((d) => d.text)
    .filter(Boolean);

  let odo = null;
  if (latest && latest.mileage != null) {
    odo = { value: Number(latest.mileage), unit: latest.mileageUnit || null };
  }

  return {
    mot_status: status,
    mot_expiry_date: expiry,
    mot_last_test_date: latest ? latest.testDate : null,
    mot_last_test_result: latest ? latest.result : null,
    mot_advisories: advisoryStrings,
    mot_defects: defectStrings,
    mot_test_count: motHistory.length,
    mot_odometer_at_last_test: odo,
    mot_source: 'dvsa',
  };
}

function toUnifiedResponse(reg, dvlaResult, motResult, specResult) {
  const dvla = dvlaResult?.data || null;
  const motHistory = mapMotHistory(motResult?.data);
  const motSchema = buildMotSchema(motResult, motHistory);

  const dvlaHasData = Boolean(dvla) && !dvlaResult?.notFound;
  const motHasData = motResult?.available && !motResult?.notFound;
  const spec = specResult && specResult.data ? specResult.data : null;
  const flagEnabled = require('./vehicleSpecService').isFlagEnabled();

  // Back-compat: DVLA often returns model: null. If our spec service has
  // a model, surface it at the root so existing clients reading `.model`
  // start working without code changes.
  const rootModel = (dvla?.model) || (spec && spec.model) || null;

  const specFields = _flattenSpecFields(spec, dvla);
  const specSource = _deriveSpecSource(spec, flagEnabled);

  return {
    registration: dvla?.registrationNumber || reg,
    make: dvla?.make || null,
    model: rootModel,
    colour: dvla?.colour || null,
    yearOfManufacture: dvla?.yearOfManufacture || null,
    fuelType: dvla?.fuelType || null,
    engineCapacity: dvla?.engineCapacity || null,
    co2Emissions: dvla?.co2Emissions || null,
    taxStatus: dvla?.taxStatus || null,
    taxDueDate: dvla?.taxDueDate || null,
    motStatus: dvla?.motStatus || null,
    motExpiryDate: dvla?.motExpiryDate || null,
    markedForExport: dvla?.markedForExport ?? null,
    wheelplan: dvla?.wheelplan || null,
    monthOfFirstRegistration: dvla?.monthOfFirstRegistration || null,
    dateOfLastV5CIssued: dvla?.dateOfLastV5CIssued || null,
    typeApproval: dvla?.typeApproval || null,
    revenueWeight: dvla?.revenueWeight || null,
    insuranceStatus: 'unavailable',
    dvlaAvailable: dvlaHasData,
    motHistoryAvailable: motHasData,
    motHistory,
    // Standard spec fields — always present, null when unavailable.
    ...specFields,
    spec_source: specSource,
    ...motSchema,
    // Detailed nested spec (kept for callers that consume the full object).
    spec,
    checkedAt: new Date().toISOString(),
    sources: {
      dvla: {
        available: Boolean(dvlaResult?.available),
        notFound: Boolean(dvlaResult?.notFound),
        error: dvlaResult?.error || null,
      },
      mot: {
        available: Boolean(motResult?.available),
        notFound: Boolean(motResult?.notFound),
        error: motResult?.error || null,
      },
      spec: {
        available: Boolean(spec),
        error: specResult?.error || null,
      },
      insurance: {
        available: false,
        error: 'askMID insurance check not yet configured',
      },
    },
  };
}

async function lookupVehicle(reg) {
  const [dvlaResult, motResult, specData] = await Promise.all([
    dvlaService.fetchDvla(reg),
    dvsaService.fetchMotHistory(reg),
    // Spec service never throws, returns null on any failure / flag-off.
    vehicleSpecService.fetchVehicleSpec(reg).catch(() => null),
  ]);
  const specResult = {
    data: specData,
    error: specData ? null : (vehicleSpecService.isFlagEnabled() ? 'spec_unavailable' : null),
  };
  return {
    response: toUnifiedResponse(reg, dvlaResult, motResult, specResult),
    dvlaResult,
    motResult,
    specResult,
  };
}

module.exports = {
  lookupVehicle,
  toUnifiedResponse,
  mapMotHistory,
  SPEC_KEYS_DEFAULT,
  buildMotSchema,
};

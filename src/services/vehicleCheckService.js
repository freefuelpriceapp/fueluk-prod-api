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

function toUnifiedResponse(reg, dvlaResult, motResult) {
  const dvla = dvlaResult?.data || null;
  const motHistory = mapMotHistory(motResult?.data);

  const dvlaHasData = Boolean(dvla) && !dvlaResult?.notFound;
  const motHasData = motResult?.available && !motResult?.notFound;

  return {
    registration: dvla?.registrationNumber || reg,
    make: dvla?.make || null,
    model: dvla?.model || null,
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
      insurance: {
        available: false,
        error: 'askMID insurance check not yet configured',
      },
    },
  };
}

async function lookupVehicle(reg) {
  const [dvlaResult, motResult] = await Promise.all([
    dvlaService.fetchDvla(reg),
    dvsaService.fetchMotHistory(reg),
  ]);
  return {
    response: toUnifiedResponse(reg, dvlaResult, motResult),
    dvlaResult,
    motResult,
  };
}

module.exports = {
  lookupVehicle,
  toUnifiedResponse,
  mapMotHistory,
};

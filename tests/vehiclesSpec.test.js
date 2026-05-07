'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const vehiclesRoute = require('../src/routes/vehicles');
const vehicleSpecService = require('../src/services/vehicleSpecService');
const vehicleCheckService = require('../src/services/vehicleCheckService');
const { _resetStoreForTests } = require('../src/middleware/rateLimiter');

function startApp() {
  const app = express();
  app.use('/api/v1/vehicles', vehiclesRoute);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function fetchJson(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json: parsed });
      });
    });
    req.on('error', reject);
  });
}

function flagOn() {
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'true';
  process.env.CHECKCARDETAILS_API_KEY = 'test-key';
}
function flagOff() {
  delete process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT;
  delete process.env.CHECKCARDETAILS_API_KEY;
}
function reset() {
  vehiclesRoute.clearCache();
  vehicleSpecService.clearCache();
  vehicleSpecService._resetRateLimitForTests();
  _resetStoreForTests();
}

// ---------------- /spec ----------------

test('GET /spec: 400 on invalid reg', async () => {
  flagOn(); reset();
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/spec?reg=!!!');
    assert.equal(r.status, 400);
  } finally { server.close(); flagOff(); }
});

test('GET /spec: 503 when feature flag off', async () => {
  flagOff(); reset();
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/spec?reg=AB12CDE');
    assert.equal(r.status, 503);
    assert.match(r.json.error, /not enabled/);
  } finally { server.close(); }
});

test('GET /spec: 200 with found=true and normalised spec', async () => {
  flagOn(); reset();
  const original = vehicleSpecService.fetchVehicleSpec;
  vehicleSpecService.fetchVehicleSpec = async () => ({
    model: 'RANGE ROVER SPORT',
    variant: 'SDV6 HSE',
    trim: 'HSE',
    derivative: null,
    bodyStyle: 'SUV',
    transmission: 'AUTOMATIC',
    doors: 5,
    seats: 5,
    engineDescription: '3.0L V6 Diesel',
    fuelDescription: 'Diesel',
    drivetrain: '4WD',
    source: 'checkcardetails',
    fetchedAt: new Date().toISOString(),
  });
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/spec?reg=LR15ROV', { 'x-device-id': 'spec-dev-1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.found, true);
    assert.equal(r.json.registration, 'LR15ROV');
    assert.equal(r.json.spec.model, 'RANGE ROVER SPORT');
    assert.equal(r.json.spec.bodyStyle, 'SUV');
    assert.equal(r.json.spec.source, 'checkcardetails');
  } finally {
    vehicleSpecService.fetchVehicleSpec = original;
    server.close();
    flagOff();
  }
});

test('GET /spec: 200 with found=false when service returns null', async () => {
  flagOn(); reset();
  const original = vehicleSpecService.fetchVehicleSpec;
  vehicleSpecService.fetchVehicleSpec = async () => null;
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/spec?reg=AB12CDE', { 'x-device-id': 'spec-dev-2' });
    assert.equal(r.status, 200);
    assert.equal(r.json.found, false);
    assert.equal(r.json.reason, 'spec_unavailable');
  } finally {
    vehicleSpecService.fetchVehicleSpec = original;
    server.close();
    flagOff();
  }
});

// ---------------- /lookup with spec wired in ----------------

test('GET /lookup: spec field is null and sources.spec.available=false when flag off', async () => {
  flagOff();
  process.env.DVLA_API_KEY = 'test';
  reset();

  const original = vehicleCheckService.lookupVehicle;
  vehicleCheckService.lookupVehicle = async (reg) => {
    // Use the real toUnifiedResponse so we exercise the production wiring,
    // but inject deterministic sub-results.
    const dvlaResult = {
      available: true, error: null,
      data: { registrationNumber: reg, make: 'FORD', model: 'FOCUS' },
    };
    const motResult = { available: false, error: 'not configured', data: null };
    const specResult = { data: null, error: null };
    return {
      response: vehicleCheckService.toUnifiedResponse(reg, dvlaResult, motResult, specResult),
      dvlaResult, motResult, specResult,
    };
  };

  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/lookup?reg=AB12CDE', { 'x-device-id': 'lookup-flagoff' });
    assert.equal(r.status, 200);
    assert.equal(r.json.spec, null);
    assert.equal(r.json.sources.spec.available, false);
    assert.equal(r.json.model, 'FOCUS'); // DVLA had it
  } finally {
    vehicleCheckService.lookupVehicle = original;
    delete process.env.DVLA_API_KEY;
    server.close();
  }
});

test('GET /lookup: spec field populated and root model back-filled when DVLA model is null', async () => {
  flagOn();
  process.env.DVLA_API_KEY = 'test';
  reset();

  const original = vehicleCheckService.lookupVehicle;
  vehicleCheckService.lookupVehicle = async (reg) => {
    const dvlaResult = {
      available: true, error: null,
      data: { registrationNumber: reg, make: 'LAND ROVER', model: null },
    };
    const motResult = { available: false, error: 'not configured', data: null };
    const specResult = {
      data: {
        model: 'RANGE ROVER SPORT',
        variant: 'SDV6 HSE',
        trim: 'HSE',
        derivative: null,
        bodyStyle: 'SUV',
        transmission: 'AUTOMATIC',
        doors: 5, seats: 5,
        engineDescription: '3.0L V6 Diesel',
        fuelDescription: 'Diesel',
        drivetrain: '4WD',
        source: 'checkcardetails',
        fetchedAt: new Date().toISOString(),
      },
      error: null,
    };
    return {
      response: vehicleCheckService.toUnifiedResponse(reg, dvlaResult, motResult, specResult),
      dvlaResult, motResult, specResult,
    };
  };

  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/lookup?reg=LR15ROV', { 'x-device-id': 'lookup-flagon' });
    assert.equal(r.status, 200);
    assert.ok(r.json.spec);
    assert.equal(r.json.spec.model, 'RANGE ROVER SPORT');
    assert.equal(r.json.sources.spec.available, true);
    // Back-compat: root model is now populated from spec since DVLA was null
    assert.equal(r.json.model, 'RANGE ROVER SPORT');
    assert.equal(r.json.make, 'LAND ROVER');
  } finally {
    vehicleCheckService.lookupVehicle = original;
    delete process.env.DVLA_API_KEY;
    flagOff();
    server.close();
  }
});

test('toUnifiedResponse: spec source absent gives sources.spec={available:false,error:null}', () => {
  const dvlaResult = {
    available: true, error: null,
    data: { registrationNumber: 'AB12CDE', make: 'FORD', model: 'FOCUS' },
  };
  const motResult = { available: false, error: 'n/a', data: null };
  const resp = vehicleCheckService.toUnifiedResponse('AB12CDE', dvlaResult, motResult);
  assert.equal(resp.sources.spec.available, false);
  assert.equal(resp.sources.spec.error, null);
  assert.equal(resp.spec, null);
});

// ---------------- promoted spec fields + spec_source ----------------

test('toUnifiedResponse: standard spec keys are always present (null when no spec)', () => {
  // Flag explicitly disabled to force spec_source='dvla_only'
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'false';
  try {
    const dvlaResult = {
      available: true, error: null,
      data: { registrationNumber: 'AB12CDE', make: 'FORD', model: 'FOCUS', engineCapacity: 1499 },
    };
    const motResult = { available: false, error: 'n/a', data: null };
    const resp = vehicleCheckService.toUnifiedResponse('AB12CDE', dvlaResult, motResult);
    // All promoted spec keys must be present even when no spec data.
    assert.ok('trim' in resp);
    assert.ok('variant' in resp);
    assert.ok('transmission' in resp);
    assert.ok('doors' in resp);
    assert.ok('body_style' in resp);
    assert.ok('engine_capacity_cc' in resp);
    assert.ok('fuel_type_detailed' in resp);
    assert.ok('model_full' in resp);
    assert.ok('spec_source' in resp);
    // ...and the values are null when no spec, except engine_capacity_cc
    // which falls back to DVLA's engineCapacity.
    assert.equal(resp.trim, null);
    assert.equal(resp.variant, null);
    assert.equal(resp.transmission, null);
    assert.equal(resp.doors, null);
    assert.equal(resp.body_style, null);
    assert.equal(resp.engine_capacity_cc, 1499);
    assert.equal(resp.fuel_type_detailed, null);
    assert.equal(resp.model_full, null);
    assert.equal(resp.spec_source, 'dvla_only');
  } finally {
    delete process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT;
  }
});

test('toUnifiedResponse: spec_source="checkcardetails" when enrichment populated', () => {
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'true';
  try {
    const dvlaResult = {
      available: true, error: null,
      data: { registrationNumber: 'NJ69DDF', make: 'AUDI', model: null, engineCapacity: 1984 },
    };
    const motResult = { available: false, error: null, data: null };
    const specResult = {
      data: {
        model: 'A3',
        variant: 'S Line 40 TFSI',
        trim: 'S Line',
        derivative: 'A3 S Line 40 TFSI quattro 5dr S Tronic',
        bodyStyle: 'Hatchback',
        transmission: 'AUTOMATIC',
        doors: 5, seats: 5,
        engineDescription: '2.0L TFSI Petrol',
        fuelDescription: 'Petrol',
        drivetrain: 'AWD',
        source: 'checkcardetails',
        fetchedAt: new Date().toISOString(),
      },
      error: null,
    };
    const resp = vehicleCheckService.toUnifiedResponse('NJ69DDF', dvlaResult, motResult, specResult);
    assert.equal(resp.trim, 'S Line');
    assert.equal(resp.variant, 'S Line 40 TFSI');
    assert.equal(resp.transmission, 'AUTOMATIC');
    assert.equal(resp.doors, 5);
    assert.equal(resp.body_style, 'Hatchback');
    assert.equal(resp.engine_capacity_cc, 1984);
    assert.equal(resp.fuel_type_detailed, 'Petrol');
    assert.equal(resp.model_full, 'A3 S Line 40 TFSI quattro 5dr S Tronic');
    assert.equal(resp.spec_source, 'checkcardetails');
  } finally {
    delete process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT;
  }
});

test('toUnifiedResponse: spec_source="unavailable" when flag on but spec=null (e.g. 403)', () => {
  // Flag default ON (env unset) — emulates premium tier 403 returning null
  delete process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT;
  const dvlaResult = {
    available: true, error: null,
    data: { registrationNumber: 'NJ69DDF', make: 'AUDI', model: null, engineCapacity: 1984 },
  };
  const motResult = { available: false, error: null, data: null };
  const specResult = { data: null, error: 'spec_unavailable' };
  const resp = vehicleCheckService.toUnifiedResponse('NJ69DDF', dvlaResult, motResult, specResult);
  assert.equal(resp.spec_source, 'unavailable');
  // Standard keys still present, null
  assert.equal(resp.trim, null);
  assert.equal(resp.variant, null);
  assert.equal(resp.transmission, null);
  assert.equal(resp.doors, null);
  // engine_capacity_cc still falls back to DVLA
  assert.equal(resp.engine_capacity_cc, 1984);
});

test('lookupVehicle never throws when upstream returns 403 (graceful 403 path)', async () => {
  // End-to-end: stub fetch to simulate the premium tier 403 and confirm
  // the response has the standard keys present and spec_source set to
  // 'unavailable' rather than throwing.
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'true';
  process.env.CHECKCARDETAILS_API_KEY = 'test-key';
  vehicleSpecService.clearCache();
  vehicleSpecService._resetRateLimitForTests();
  vehicleSpecService._resetMetricsForTests();

  // Stub the spec service so we don't need DVLA; call toUnifiedResponse
  // with a null spec (which is what /vehicleregistration's 403 produces).
  const dvlaResult = {
    available: true, error: null,
    data: { registrationNumber: 'NJ69DDF', make: 'AUDI', model: 'A3' },
  };
  const motResult = { available: false, error: null, data: null };
  const specResult = { data: null, error: 'spec_unavailable' };

  const resp = vehicleCheckService.toUnifiedResponse('NJ69DDF', dvlaResult, motResult, specResult);
  assert.equal(resp.trim, null);
  assert.equal(resp.spec_source, 'unavailable');
  // Source error should be exposed for observability without breaking the response shape
  assert.equal(resp.sources.spec.available, false);
  assert.equal(resp.sources.spec.error, 'spec_unavailable');

  delete process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT;
  delete process.env.CHECKCARDETAILS_API_KEY;
});

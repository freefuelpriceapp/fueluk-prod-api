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

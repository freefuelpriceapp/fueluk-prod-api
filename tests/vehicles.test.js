'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

// NOTE: vehicles route reads process.env at request time, so we can toggle
// DVLA_API_KEY / DVSA_MOT_API_KEY per-test by mutating process.env.
const vehiclesRoute = require('../src/routes/vehicles');
const {
  normaliseReg,
  estimateMpg,
  yearFromAgeIdentifier,
  mockVehicleFor,
  clearCache,
} = vehiclesRoute;
const vehicleCheckService = require('../src/services/vehicleCheckService');

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
        try { parsed = JSON.parse(body); } catch (_) { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json: parsed });
      });
    });
    req.on('error', reject);
  });
}

// ----- pure helpers -----

test('normaliseReg strips spaces and uppercases', () => {
  assert.equal(normaliseReg('ab12 cde'), 'AB12CDE');
  assert.equal(normaliseReg('  AB12CDE '), 'AB12CDE');
});

test('normaliseReg strips non-alphanumeric characters', () => {
  assert.equal(normaliseReg('ab12-cde'), 'AB12CDE');
  assert.equal(normaliseReg('AB12.CDE'), 'AB12CDE');
});

test('normaliseReg rejects obvious garbage', () => {
  assert.equal(normaliseReg(''), null);
  assert.equal(normaliseReg('!!!'), null);
  assert.equal(normaliseReg(null), null);
  assert.equal(normaliseReg(undefined), null);
});

test('normaliseReg rejects all-digit or all-letter "plates"', () => {
  assert.equal(normaliseReg('12345'), null);
  assert.equal(normaliseReg('ABCDEF'), null);
});

test('normaliseReg rejects too-short or too-long input', () => {
  assert.equal(normaliseReg('A'), null);
  assert.equal(normaliseReg('ABCDEFGHIJ'), null);
});

test('yearFromAgeIdentifier handles both period formats', () => {
  assert.equal(yearFromAgeIdentifier('24'), 2024);
  assert.equal(yearFromAgeIdentifier('74'), 2024);
  assert.equal(yearFromAgeIdentifier('12'), 2012);
  assert.equal(yearFromAgeIdentifier('62'), 2012);
});

test('estimateMpg gives higher mpg to small-diesel than big-petrol', () => {
  assert.ok(estimateMpg('DIESEL', 1500) > estimateMpg('PETROL', 2500));
});

test('estimateMpg returns 0 for pure electric', () => {
  assert.equal(estimateMpg('ELECTRIC', 0), 0);
});

test('estimateMpg treats hybrid as ~60 mpg', () => {
  assert.equal(estimateMpg('HYBRID ELECTRIC', 1800), 60);
});

// ----- mock fallback & unified schema -----

test('mockVehicleFor returns unified schema with source="mock"', () => {
  const v = mockVehicleFor('AB12CDE');
  assert.equal(v.source, 'mock');
  assert.equal(v.registration, 'AB12CDE');
  assert.equal(v.dvlaAvailable, false);
  assert.equal(v.motHistoryAvailable, false);
  assert.deepEqual(v.motHistory, []);
  assert.ok(v.sources && v.sources.dvla && v.sources.mot && v.sources.insurance);
  assert.equal(v.sources.insurance.available, false);
});

test('vehicleCheckService.mapMotHistory normalises DVSA defects', () => {
  const raw = [{
    motTests: [{
      completedDate: '2024-08-10T09:15:00.000Z',
      testResult: 'PASSED',
      odometerValue: '42150',
      odometerUnit: 'mi',
      expiryDate: '2025-08-09',
      motTestNumber: '123456789012',
      defects: [
        { text: 'Nearside tyre worn', type: 'ADVISORY', dangerous: false },
        { text: 'Brake pipe corroded', type: 'DANGEROUS', dangerous: true },
      ],
    }],
  }];
  const hist = vehicleCheckService.mapMotHistory(raw);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].result, 'PASSED');
  assert.equal(hist[0].mileage, 42150);
  assert.equal(hist[0].defects.length, 2);
  assert.equal(hist[0].defects[1].dangerous, true);
});

test('vehicleCheckService.toUnifiedResponse sets flags from source availability', () => {
  const dvlaResult = {
    available: true,
    error: null,
    data: {
      registrationNumber: 'AB12CDE',
      make: 'FORD',
      model: 'FOCUS',
      yearOfManufacture: 2019,
      fuelType: 'PETROL',
      taxStatus: 'Taxed',
      motStatus: 'Valid',
    },
  };
  const motResult = { available: false, error: 'DVSA_MOT_API_KEY not configured', data: null };
  const resp = vehicleCheckService.toUnifiedResponse('AB12CDE', dvlaResult, motResult);
  assert.equal(resp.dvlaAvailable, true);
  assert.equal(resp.motHistoryAvailable, false);
  assert.equal(resp.make, 'FORD');
  assert.equal(resp.sources.mot.error, 'DVSA_MOT_API_KEY not configured');
  assert.equal(resp.insuranceStatus, 'unavailable');
});

// ----- route behaviour -----

test('GET /lookup returns 400 for invalid reg', async () => {
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/lookup?reg=!!!');
    assert.equal(r.status, 400);
  } finally { server.close(); }
});

test('GET /lookup returns mock data when no API keys are configured', async () => {
  delete process.env.DVLA_API_KEY;
  delete process.env.DVSA_MOT_API_KEY;
  clearCache();
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/lookup?reg=AB12CDE');
    assert.equal(r.status, 200);
    assert.equal(r.json.source, 'mock');
    assert.equal(r.json.dvlaAvailable, false);
    assert.equal(r.json.registration, 'AB12CDE');
  } finally { server.close(); }
});

test('GET /lookup caches responses (second call is X-Cache: HIT)', async () => {
  delete process.env.DVLA_API_KEY;
  delete process.env.DVSA_MOT_API_KEY;
  clearCache();
  const { server, port } = await startApp();
  try {
    // Mock fallback is not cached (keys absent), but we still want to prove
    // the cache path works when a real response exists — stub the service.
    process.env.DVLA_API_KEY = 'test';
    const originalLookup = vehicleCheckService.lookupVehicle;
    let calls = 0;
    vehicleCheckService.lookupVehicle = async (reg) => {
      calls += 1;
      return {
        response: {
          registration: reg,
          make: 'FORD', model: 'FOCUS',
          dvlaAvailable: true, motHistoryAvailable: false,
          motHistory: [],
          sources: {
            dvla: { available: true, error: null },
            mot: { available: false, error: 'not configured' },
            insurance: { available: false, error: 'n/a' },
          },
        },
        dvlaResult: { available: true }, motResult: { available: false },
      };
    };
    try {
      const a = await fetchJson(port, '/api/v1/vehicles/lookup?reg=AB12CDE');
      const b = await fetchJson(port, '/api/v1/vehicles/lookup?reg=AB12CDE');
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(a.headers['x-cache'], 'MISS');
      assert.equal(b.headers['x-cache'], 'HIT');
      assert.equal(calls, 1);

      const c = await fetchJson(port, '/api/v1/vehicles/lookup?reg=AB12CDE&refresh=true');
      assert.equal(c.headers['x-cache'], 'BYPASS');
      assert.equal(calls, 2);
    } finally {
      vehicleCheckService.lookupVehicle = originalLookup;
      delete process.env.DVLA_API_KEY;
      clearCache();
    }
  } finally { server.close(); }
});

test('GET /lookup returns 429 with retry_after_seconds when device daily cap exceeded', async () => {
  delete process.env.DVLA_API_KEY;
  delete process.env.DVSA_MOT_API_KEY;
  clearCache();
  const { _resetStoreForTests } = require('../src/middleware/rateLimiter');
  _resetStoreForTests();
  const { server, port } = await startApp();
  try {
    const deviceId = 'device-test-limit-1';
    let limitResp = null;
    // Device cap is 30/day. 31st should 429.
    for (let i = 0; i < 31; i++) {
      const r = await fetchJson(
        port,
        `/api/v1/vehicles/lookup?reg=AB12CDE&_i=${i}`,
        { 'x-device-id': deviceId },
      );
      if (r.status === 429) { limitResp = r; break; }
    }
    assert.ok(limitResp, 'expected a 429 on the 31st request');
    assert.equal(typeof limitResp.json.retry_after_seconds, 'number');
    assert.ok(limitResp.json.retry_after_seconds > 0);
    assert.ok(limitResp.json.message && limitResp.json.message.length > 0);
  } finally { server.close(); }
});

test('GET /lookup: a different device_id is not blocked when another device is exhausted', async () => {
  delete process.env.DVLA_API_KEY;
  delete process.env.DVSA_MOT_API_KEY;
  clearCache();
  const { _resetStoreForTests } = require('../src/middleware/rateLimiter');
  _resetStoreForTests();
  const { server, port } = await startApp();
  try {
    const exhausted = 'device-exhausted-A';
    for (let i = 0; i < 31; i++) {
      await fetchJson(
        port,
        `/api/v1/vehicles/lookup?reg=AB12CDE&_i=${i}`,
        { 'x-device-id': exhausted },
      );
    }
    // Confirm exhausted
    const blocked = await fetchJson(port, '/api/v1/vehicles/lookup?reg=AB12CDE', { 'x-device-id': exhausted });
    assert.equal(blocked.status, 429);

    // Fresh device should be fine on first call.
    const fresh = await fetchJson(port, '/api/v1/vehicles/lookup?reg=AB12CDE', { 'x-device-id': 'device-fresh-B' });
    assert.equal(fresh.status, 200);
  } finally { server.close(); }
});

test('GET /lookup: missing device_id falls back to per-IP bucket (generous)', async () => {
  delete process.env.DVLA_API_KEY;
  delete process.env.DVSA_MOT_API_KEY;
  clearCache();
  const { _resetStoreForTests } = require('../src/middleware/rateLimiter');
  _resetStoreForTests();
  const { server, port } = await startApp();
  try {
    // IP bucket is 60/hour; 31 requests without a device_id must all pass.
    const ip = '203.0.113.99';
    for (let i = 0; i < 31; i++) {
      const r = await fetchJson(
        port,
        `/api/v1/vehicles/lookup?reg=AB12CDE&_i=${i}`,
        { 'x-forwarded-for': ip },
      );
      assert.equal(r.status, 200, `request ${i} should succeed on IP fallback`);
      assert.equal(r.headers['x-ratelimit-scope'], 'ip');
    }
  } finally { server.close(); }
});

test('GET /lookup: device_id via query param works equivalently to header', async () => {
  delete process.env.DVLA_API_KEY;
  delete process.env.DVSA_MOT_API_KEY;
  clearCache();
  const { _resetStoreForTests } = require('../src/middleware/rateLimiter');
  _resetStoreForTests();
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/lookup?reg=AB12CDE&device_id=qp-device-1');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-ratelimit-scope'], 'device');
  } finally { server.close(); }
});

test('GET /insurance-check returns MIB Navigate metadata with expected shape', async () => {
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/insurance-check');
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, 'MIB Navigate');
    assert.equal(r.json.url, 'https://enquiry.navigate.mib.org.uk/checkyourvehicle');
    assert.equal(r.json.contactUrl, 'https://enquiry.navigate.mib.org.uk/contact-us');
    assert.ok(Array.isArray(r.json.checkTypes));
    assert.equal(r.json.checkTypes.length, 2);
    assert.deepEqual(
      r.json.checkTypes.map((c) => c.type).sort(),
      ['personal', 'third_party'],
    );
    assert.ok(r.json.terms && r.json.terms.length > 0);
    assert.ok(r.json.disclaimer && r.json.disclaimer.length > 0);
  } finally { server.close(); }
});

test('GET /insurance-check sets 24h Cache-Control header', async () => {
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/insurance-check');
    assert.equal(r.status, 200);
    assert.match(r.headers['cache-control'] || '', /max-age=86400/);
  } finally { server.close(); }
});

test('GET /lookup gracefully degrades when one API fails', async () => {
  delete process.env.DVLA_API_KEY;
  delete process.env.DVSA_MOT_API_KEY;
  clearCache();
  process.env.DVLA_API_KEY = 'test';
  const originalLookup = vehicleCheckService.lookupVehicle;
  vehicleCheckService.lookupVehicle = async (reg) => ({
    response: {
      registration: reg, make: 'FORD', model: 'FOCUS',
      dvlaAvailable: true, motHistoryAvailable: false, motHistory: [],
      sources: {
        dvla: { available: true, error: null },
        mot: { available: false, error: 'DVSA API 500: upstream error' },
        insurance: { available: false, error: 'n/a' },
      },
    },
    dvlaResult: { available: true }, motResult: { available: false },
  });
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/lookup?reg=CD34EFG');
    assert.equal(r.status, 200);
    assert.equal(r.json.dvlaAvailable, true);
    assert.equal(r.json.motHistoryAvailable, false);
    assert.ok(r.json.sources.mot.error);
  } finally {
    vehicleCheckService.lookupVehicle = originalLookup;
    delete process.env.DVLA_API_KEY;
    clearCache();
    server.close();
  }
});

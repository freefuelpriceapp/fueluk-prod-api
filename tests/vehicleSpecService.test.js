'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const vehicleSpecService = require('../src/services/vehicleSpecService');

function envOn() {
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'true';
  process.env.CHECKCARDETAILS_API_KEY = 'test-key';
}
function envOff() {
  delete process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT;
  delete process.env.CHECKCARDETAILS_API_KEY;
}
function reset() {
  vehicleSpecService.clearCache();
  vehicleSpecService._resetRateLimitForTests();
}

function jsonResponse(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function rawTextResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => text,
  };
}

test('fetchVehicleSpec returns null when feature flag off (and never calls upstream)', async () => {
  envOff(); reset();
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse({}); };
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('fetchVehicleSpec returns null when key missing (flag on)', async () => {
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'true';
  delete process.env.CHECKCARDETAILS_API_KEY;
  reset();
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse({}); };
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(result, null);
  assert.equal(called, false);
  envOff();
});

test('fetchVehicleSpec normalises a successful response', async () => {
  envOn(); reset();
  const fetchImpl = async () => jsonResponse({
    data: {
      spec: {
        model: 'RANGE ROVER SPORT',
        variant: 'SDV6 HSE Dynamic',
        trim: 'HSE Dynamic',
        derivative: '3.0 SDV6 HSE Dynamic 5dr Auto',
        bodyStyle: 'SUV',
        transmission: 'AUTOMATIC',
        doors: 5,
        seats: 5,
        engineDescription: '3.0L V6 Diesel',
        fuelDescription: 'Diesel',
        drivetrain: '4WD',
      },
    },
  });
  const result = await vehicleSpecService.fetchVehicleSpec('LR15ROV', { fetchImpl });
  assert.equal(result.model, 'RANGE ROVER SPORT');
  assert.equal(result.variant, 'SDV6 HSE Dynamic');
  assert.equal(result.trim, 'HSE Dynamic');
  assert.equal(result.bodyStyle, 'SUV');
  assert.equal(result.transmission, 'AUTOMATIC');
  assert.equal(result.doors, 5);
  assert.equal(result.seats, 5);
  assert.equal(result.engineDescription, '3.0L V6 Diesel');
  assert.equal(result.drivetrain, '4WD');
  assert.equal(result.source, 'checkcardetails');
  assert.ok(result.fetchedAt);
  envOff();
});

test('fetchVehicleSpec missing fields default to null', async () => {
  envOn(); reset();
  const fetchImpl = async () => jsonResponse({ data: { spec: { model: 'X' } } });
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(result.model, 'X');
  assert.equal(result.variant, null);
  assert.equal(result.trim, null);
  assert.equal(result.bodyStyle, null);
  assert.equal(result.transmission, null);
  assert.equal(result.doors, null);
  assert.equal(result.seats, null);
  envOff();
});

test('fetchVehicleSpec returns null on 404', async () => {
  envOn(); reset();
  const fetchImpl = async () => jsonResponse({ error: 'not found' }, 404);
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(result, null);
  envOff();
});

test('fetchVehicleSpec returns null on 500', async () => {
  envOn(); reset();
  const fetchImpl = async () => jsonResponse({ error: 'boom' }, 500);
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(result, null);
  envOff();
});

test('fetchVehicleSpec returns null on timeout (AbortError)', async () => {
  envOn(); reset();
  const fetchImpl = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl, timeoutMs: 10 });
  assert.equal(result, null);
  envOff();
});

test('fetchVehicleSpec returns null on malformed JSON', async () => {
  envOn(); reset();
  const fetchImpl = async () => rawTextResponse('not json {{', 200);
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(result, null);
  envOff();
});

test('fetchVehicleSpec caches second call (no upstream hit)', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ data: { spec: { model: 'GOLF', trim: 'GTI' } } });
  };
  const a = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  const b = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(calls, 1);
  assert.equal(a.model, 'GOLF');
  assert.equal(b.model, 'GOLF');
  envOff();
});

test('fetchVehicleSpec cache miss for different reg', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ data: { spec: { model: 'X' } } });
  };
  await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  await vehicleSpecService.fetchVehicleSpec('CD34EFG', { fetchImpl });
  assert.equal(calls, 2);
  envOff();
});

test('fetchVehicleSpec sends x-api-key header and reg in URL', async () => {
  envOn(); reset();
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ data: { spec: { model: 'X' } } });
  };
  await vehicleSpecService.fetchVehicleSpec('ab12 cde', { fetchImpl });
  assert.match(captured.url, /vrm=AB12CDE/);
  assert.equal(captured.init.headers['x-api-key'], 'test-key');
  assert.equal(captured.init.method, 'GET');
  envOff();
});

test('fetchVehicleSpec invalid reg returns null', async () => {
  envOn(); reset();
  const r = await vehicleSpecService.fetchVehicleSpec('', { fetchImpl: async () => jsonResponse({}) });
  assert.equal(r, null);
  envOff();
});

test('isFlagEnabled is false unless env is exact "true"', () => {
  envOff();
  assert.equal(vehicleSpecService.isFlagEnabled(), false);
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'TRUE';
  assert.equal(vehicleSpecService.isFlagEnabled(), true);
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'false';
  assert.equal(vehicleSpecService.isFlagEnabled(), false);
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = '1';
  assert.equal(vehicleSpecService.isFlagEnabled(), false);
  envOff();
});

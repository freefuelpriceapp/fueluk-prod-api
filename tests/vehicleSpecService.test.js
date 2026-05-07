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
function envFlagDisabled() {
  // Flag default is ON, so to truly disable we set it explicitly to "false".
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'false';
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

test('fetchVehicleSpec returns null when feature flag explicitly disabled (and never calls upstream)', async () => {
  envFlagDisabled(); reset();
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse({}); };
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(result, null);
  assert.equal(called, false);
  envOff();
});

test('fetchVehicleSpec returns null when key missing (default flag-on)', async () => {
  envOff(); reset();
  let called = false;
  const fetchImpl = async () => { called = true; return jsonResponse({}); };
  const result = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(result, null);
  // Flag is on by default but key missing → no upstream call, returns null.
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

test('fetchVehicleSpec sends apikey query param and reg in URL', async () => {
  envOn(); reset();
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ model: 'X' });
  };
  await vehicleSpecService.fetchVehicleSpec('ab12 cde', { fetchImpl });
  assert.match(captured.url, /vrm=AB12CDE/);
  assert.match(captured.url, /apikey=test-key/);
  assert.match(captured.url, /\/vehicleregistration\?/);
  // header-based auth no longer used; ensure none of the request headers contain the key
  const headerVals = Object.values(captured.init.headers || {}).join(' ');
  assert.ok(!headerVals.includes('test-key'));
  assert.equal(captured.init.method, 'GET');
  envOff();
});

test('fetchVehicleSpec invalid reg returns null', async () => {
  envOn(); reset();
  const r = await vehicleSpecService.fetchVehicleSpec('', { fetchImpl: async () => jsonResponse({}) });
  assert.equal(r, null);
  envOff();
});

test('isFlagEnabled defaults ON; only explicit "false" disables it', () => {
  envOff();
  // Env var unset → enabled (default ON)
  assert.equal(vehicleSpecService.isFlagEnabled(), true);
  // Empty string → enabled (treat as unset)
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = '';
  assert.equal(vehicleSpecService.isFlagEnabled(), true);
  // Explicit "true" → enabled
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'true';
  assert.equal(vehicleSpecService.isFlagEnabled(), true);
  // Explicit "TRUE" → enabled (case-insensitive)
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'TRUE';
  assert.equal(vehicleSpecService.isFlagEnabled(), true);
  // Explicit "false" → disabled
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'false';
  assert.equal(vehicleSpecService.isFlagEnabled(), false);
  // Other values default to enabled (anything not "false")
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = '1';
  assert.equal(vehicleSpecService.isFlagEnabled(), true);
  envOff();
});

test('isConfigured requires both flag-on and key-present', () => {
  envOff();
  // Default flag on, but no key → not configured
  assert.equal(vehicleSpecService.isConfigured(), false);
  // Key present, default flag on → configured
  process.env.CHECKCARDETAILS_API_KEY = 'k';
  assert.equal(vehicleSpecService.isConfigured(), true);
  // Key present but flag explicitly disabled → not configured
  process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT = 'false';
  assert.equal(vehicleSpecService.isConfigured(), false);
  envOff();
});

test('fetchVehicleSpec returns null on 403 and negative-caches for 24h', async () => {
  envOn(); reset();
  vehicleSpecService._resetMetricsForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ error: 'premium tier not authorised' }, 403);
  };
  const a = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  const b = await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(a, null);
  assert.equal(b, null);
  // Second call should hit the negative cache, not the upstream.
  assert.equal(calls, 1);
  envOff();
});

test('fetchVehicleSpec 404 also negative-caches for 24h', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ error: 'not found' }, 404);
  };
  await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  assert.equal(calls, 1);
  envOff();
});

test('fetchVehicleSpec 500 does NOT negative-cache (transient error)', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ error: 'boom' }, 500);
  };
  await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl });
  // Both calls go upstream — 5xx is transient and shouldn't be cached.
  assert.equal(calls, 2);
  envOff();
});

test('getMetricsSnapshot reports calls/errors and premium tier authorisation', async () => {
  envOn(); reset();
  vehicleSpecService._resetMetricsForTests();
  // One success with trim → premium authorised
  const okFetch = async () => jsonResponse({
    data: { spec: { model: 'GOLF', trim: 'GTI' } },
  });
  await vehicleSpecService.fetchVehicleSpec('AB12CDE', { fetchImpl: okFetch });
  // One error
  const errFetch = async () => jsonResponse({ error: 'no' }, 500);
  await vehicleSpecService.fetchVehicleSpec('XY34ZAB', { fetchImpl: errFetch });
  const snap = vehicleSpecService.getMetricsSnapshot();
  assert.equal(snap.last_24h_calls, 2);
  assert.equal(snap.last_24h_errors, 1);
  assert.equal(snap.premium_tier_authorised, true);
  envOff();
});

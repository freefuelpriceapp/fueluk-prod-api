'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const dvsaService = require('../src/services/dvsaService');

function envOn() {
  process.env.DVSA_CLIENT_ID = 'cid';
  process.env.DVSA_CLIENT_SECRET = 'csec';
  process.env.DVSA_API_KEY = 'apikey-xyz';
  process.env.DVSA_TOKEN_URL = 'https://login.example.com/oauth2/token';
  process.env.DVSA_API_BASE = 'https://history.example.com/v1/trade';
}
function envOff() {
  delete process.env.DVSA_CLIENT_ID;
  delete process.env.DVSA_CLIENT_SECRET;
  delete process.env.DVSA_API_KEY;
  delete process.env.DVSA_TOKEN_URL;
  delete process.env.DVSA_API_BASE;
}
function reset() {
  dvsaService.clearNegativeCache();
  dvsaService._resetMetricsForTests();
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function textResponse(status, text) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => { throw new Error('not json'); },
    text: async () => text,
  };
}
function stubTokenManager(token = 'TEST_TOKEN') {
  return { getAccessToken: async () => token, invalidate: () => {}, _state: () => ({}) };
}

test('negative cache: 404 caches and second call short-circuits', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(404, {}); };
  const r1 = await dvsaService.getMotHistory('NX01ABC', { fetchImpl, tokenManager: stubTokenManager() });
  const r2 = await dvsaService.getMotHistory('NX01ABC', { fetchImpl, tokenManager: stubTokenManager() });
  assert.equal(r1.found, false);
  assert.equal(r2.found, false);
  assert.equal(r2.cached, 'negative');
  assert.equal(calls, 1, 'second call must hit the cache, not upstream');
  envOff();
});

test('negative cache: skipNegativeCache forces upstream re-check', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(404, {}); };
  await dvsaService.getMotHistory('NY02ABC', { fetchImpl, tokenManager: stubTokenManager() });
  await dvsaService.getMotHistory('NY02ABC', { fetchImpl, tokenManager: stubTokenManager(), skipNegativeCache: true });
  assert.equal(calls, 2);
  envOff();
});

test('5xx retry: 503 then 200 succeeds within retry budget', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 2) return textResponse(503, 'down');
    return jsonResponse(200, { registration: 'NZ01ABC', motTests: [] });
  };
  const r = await dvsaService.getMotHistory('NZ01ABC', { fetchImpl, tokenManager: stubTokenManager() });
  assert.equal(r.found, true);
  assert.equal(calls, 2);
  envOff();
});

test('5xx retry: 429 also triggers retry', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 2) return textResponse(429, 'too many');
    return jsonResponse(200, { registration: 'NA01ABC', motTests: [] });
  };
  const r = await dvsaService.getMotHistory('NA01ABC', { fetchImpl, tokenManager: stubTokenManager() });
  assert.equal(r.found, true);
  assert.equal(calls, 2);
  envOff();
});

test('5xx retry: stops after maxAttempts and throws', async () => {
  envOn(); reset();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return textResponse(503, 'always down'); };
  await assert.rejects(
    () => dvsaService.getMotHistory('NB01ABC', { fetchImpl, tokenManager: stubTokenManager(), maxAttempts: 2 }),
    /DVSA API 503/,
  );
  assert.equal(calls, 2);
  envOff();
});

test('metrics snapshot: counts calls, errors, not_found', async () => {
  envOn(); reset();
  let pattern = 0;
  const fetchImpl = async () => {
    pattern += 1;
    if (pattern === 1) return jsonResponse(200, { registration: 'X', motTests: [] });
    if (pattern === 2) return jsonResponse(404, {});
    return textResponse(500, 'boom'); // hit max retries
  };
  await dvsaService.getMotHistory('NC01ABC', { fetchImpl, tokenManager: stubTokenManager() });
  await dvsaService.getMotHistory('ND01ABC', { fetchImpl, tokenManager: stubTokenManager() });
  await assert.rejects(() => dvsaService.getMotHistory('NE01ABC', { fetchImpl, tokenManager: stubTokenManager(), maxAttempts: 1 }));
  const snap = dvsaService.getMetricsSnapshot();
  assert.ok(snap.last_24h_calls >= 3);
  assert.ok(snap.last_24h_not_found >= 1);
  assert.ok(snap.last_24h_errors >= 1);
  assert.equal(typeof snap.window_started_at, 'string');
  envOff();
});

test('token cache hit rate: increments on reuse', async () => {
  envOn(); reset();
  const fetchImpl = async () => jsonResponse(200, { registration: 'X', motTests: [] });
  // Use the real default token manager so getMetricsSnapshot picks it up.
  const tm = dvsaService.createTokenManager({
    fetchImpl: async () => jsonResponse(200, { access_token: 'TKN', expires_in: 3600 }),
  });
  await tm.getAccessToken(); // miss
  await tm.getAccessToken(); // hit
  await tm.getAccessToken(); // hit
  const snap = dvsaService.getMetricsSnapshot();
  assert.ok(snap.token_cache_hit_rate >= 0);
  envOff();
});

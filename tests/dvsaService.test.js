'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const dvsaService = require('../src/services/dvsaService');
const { createTokenManager, parseMotResponse, normaliseReg } = dvsaService;

function resetDvsaState() {
  dvsaService.clearNegativeCache();
  dvsaService._resetMetricsForTests();
}

// ---------- helpers ----------

function envOn() {
  process.env.DVSA_CLIENT_ID = 'cid';
  process.env.DVSA_CLIENT_SECRET = 'csec';
  process.env.DVSA_API_KEY = 'apikey-xyz';
  process.env.DVSA_TOKEN_URL = 'https://login.example.com/oauth2/token';
  process.env.DVSA_SCOPE = 'https://tapi.dvsa.gov.uk/.default';
  process.env.DVSA_API_BASE = 'https://history.example.com/v1/trade';
}
function envOff() {
  delete process.env.DVSA_CLIENT_ID;
  delete process.env.DVSA_CLIENT_SECRET;
  delete process.env.DVSA_API_KEY;
  delete process.env.DVSA_TOKEN_URL;
  delete process.env.DVSA_SCOPE;
  delete process.env.DVSA_API_BASE;
}

function jsonResponse(status, body, init = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...init,
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

// ---------- isConfigured ----------

test('isConfigured: false when none set', () => {
  envOff();
  assert.equal(dvsaService.isConfigured(), false);
});

test('isConfigured: true when all four are set', () => {
  envOn(); resetDvsaState();
  assert.equal(dvsaService.isConfigured(), true);
  envOff();
});

test('isConfigured: false if API key missing', () => {
  envOn(); resetDvsaState();
  delete process.env.DVSA_API_KEY;
  assert.equal(dvsaService.isConfigured(), false);
  envOff();
});

test('isConfigured: false if token url missing', () => {
  envOn(); resetDvsaState();
  delete process.env.DVSA_TOKEN_URL;
  assert.equal(dvsaService.isConfigured(), false);
  envOff();
});

// ---------- normaliseReg ----------

test('normaliseReg: strips spaces and uppercases', () => {
  assert.equal(normaliseReg('ab12 cde'), 'AB12CDE');
  assert.equal(normaliseReg('  KR18 YYP  '), 'KR18YYP');
});
test('normaliseReg: empty / null safe', () => {
  assert.equal(normaliseReg(''), '');
  assert.equal(normaliseReg(null), '');
  assert.equal(normaliseReg(undefined), '');
});

// ---------- token manager ----------

test('tokenManager: fetches token on first call and caches it', async () => {
  envOn(); resetDvsaState();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { access_token: 'TKN', expires_in: 3600 });
  };
  const tm = createTokenManager({ fetchImpl, now: () => 1_000_000 });
  const a = await tm.getAccessToken();
  const b = await tm.getAccessToken();
  assert.equal(a, 'TKN');
  assert.equal(b, 'TKN');
  assert.equal(calls, 1);
  envOff();
});

test('tokenManager: refreshes when within skew window of expiry', async () => {
  envOn(); resetDvsaState();
  let calls = 0;
  let nowMs = 1_000_000;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { access_token: `TKN-${calls}`, expires_in: 60 });
  };
  const tm = createTokenManager({ fetchImpl, now: () => nowMs });
  await tm.getAccessToken();
  // jump past skew (refresh window is 60s before expiry, expires_in 60s)
  nowMs += 5_000;
  await tm.getAccessToken();
  // Expiry was at +60s, skew is 60s -> refresh threshold is at +0s. After +5s
  // the token must already have been refreshed.
  assert.equal(calls, 2);
  envOff();
});

test('tokenManager: invalidate forces a fresh fetch', async () => {
  envOn(); resetDvsaState();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { access_token: `T${calls}`, expires_in: 3600 });
  };
  const tm = createTokenManager({ fetchImpl, now: () => 1_000_000 });
  await tm.getAccessToken();
  tm.invalidate();
  await tm.getAccessToken();
  assert.equal(calls, 2);
  envOff();
});

test('tokenManager: throws on missing creds', async () => {
  envOff();
  const tm = createTokenManager({});
  await assert.rejects(() => tm.getAccessToken(), /not configured/);
});

test('tokenManager: throws on non-2xx token endpoint response', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => textResponse(500, 'boom');
  const tm = createTokenManager({ fetchImpl });
  await assert.rejects(() => tm.getAccessToken(), /DVSA token endpoint 500/);
  envOff();
});

test('tokenManager: throws when access_token missing in body', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => jsonResponse(200, { expires_in: 3600 });
  const tm = createTokenManager({ fetchImpl });
  await assert.rejects(() => tm.getAccessToken(), /missing access_token/);
  envOff();
});

test('tokenManager: deduplicates concurrent in-flight requests', async () => {
  envOn(); resetDvsaState();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return jsonResponse(200, { access_token: 'TKN', expires_in: 3600 });
  };
  const tm = createTokenManager({ fetchImpl });
  const [a, b, c] = await Promise.all([
    tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken(),
  ]);
  assert.equal(a, 'TKN');
  assert.equal(b, 'TKN');
  assert.equal(c, 'TKN');
  assert.equal(calls, 1);
  envOff();
});

test('tokenManager: posts urlencoded grant_type=client_credentials', async () => {
  envOn(); resetDvsaState();
  let bodySeen = null;
  let headersSeen = null;
  const fetchImpl = async (_url, init) => {
    bodySeen = init.body;
    headersSeen = init.headers;
    return jsonResponse(200, { access_token: 'TKN', expires_in: 3600 });
  };
  const tm = createTokenManager({ fetchImpl });
  await tm.getAccessToken();
  assert.match(bodySeen, /grant_type=client_credentials/);
  assert.match(bodySeen, /client_id=cid/);
  assert.match(bodySeen, /client_secret=csec/);
  assert.match(bodySeen, /scope=/);
  assert.equal(headersSeen['Content-Type'], 'application/x-www-form-urlencoded');
  envOff();
});

// ---------- parseMotResponse ----------

test('parseMotResponse: handles array-wrapped vehicle', () => {
  const r = parseMotResponse([
    { registration: 'KR18YYP', make: 'FORD', model: 'FOCUS', motTests: [] },
  ], 'KR18YYP');
  assert.equal(r.found, true);
  assert.equal(r.make, 'FORD');
  assert.equal(r.model, 'FOCUS');
  assert.deepEqual(r.motTests, []);
});

test('parseMotResponse: handles single-object vehicle', () => {
  const r = parseMotResponse(
    { registration: 'KR18YYP', make: 'FORD', primaryColour: 'BLUE', motTests: [] },
    'KR18YYP',
  );
  assert.equal(r.found, true);
  assert.equal(r.primaryColour, 'BLUE');
});

test('parseMotResponse: handles empty/null payload as not-found', () => {
  assert.equal(parseMotResponse(null, 'X').found, false);
  assert.equal(parseMotResponse([], 'X').found, false);
});

test('parseMotResponse: maps motTests with defects/rfrAndComments', () => {
  const r = parseMotResponse({
    registration: 'KR18YYP',
    motTests: [
      {
        completedDate: '2024-08-10T09:15:00.000Z',
        testResult: 'PASSED',
        odometerValue: '42150',
        odometerUnit: 'mi',
        expiryDate: '2025-08-09',
        motTestNumber: '123',
        defects: [
          { text: 'Tyre worn', type: 'ADVISORY', dangerous: false },
          { text: 'Brake pipe', type: 'DANGEROUS', dangerous: true },
        ],
      },
      {
        completedDate: '2023-08-10',
        testResult: 'FAILED',
        rfrAndComments: [{ text: 'OSF lower arm', type: 'FAIL', dangerous: false }],
      },
    ],
  }, 'KR18YYP');
  assert.equal(r.motTests.length, 2);
  assert.equal(r.motTests[0].odometerValue, 42150);
  assert.equal(r.motTests[0].rfrAndComments.length, 2);
  assert.equal(r.motTests[0].rfrAndComments[1].dangerous, true);
  assert.equal(r.motTests[1].rfrAndComments[0].text, 'OSF lower arm');
});

test('parseMotResponse: empty motTests array returns []', () => {
  const r = parseMotResponse({ registration: 'X', motTests: undefined }, 'X');
  assert.equal(r.found, true);
  assert.deepEqual(r.motTests, []);
});

// ---------- getMotHistory ----------

function stubTokenManager(token = 'TEST_TOKEN') {
  let invalidated = 0;
  return {
    invalidated: () => invalidated,
    getAccessToken: async () => token,
    invalidate: () => { invalidated += 1; },
    _state: () => ({}),
  };
}

test('getMotHistory: 200 returns parsed payload', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async (_url, init) => {
    assert.match(init.headers.Authorization, /^Bearer /);
    assert.equal(init.headers['X-API-Key'], 'apikey-xyz');
    assert.equal(init.headers.Accept, 'application/json+v6');
    return jsonResponse(200, {
      registration: 'KR18YYP', make: 'FORD', model: 'FOCUS',
      motTests: [{ testResult: 'PASSED', completedDate: '2024-08-10' }],
    });
  };
  const r = await dvsaService.getMotHistory('kr18 yyp', { fetchImpl, tokenManager: stubTokenManager() });
  assert.equal(r.found, true);
  assert.equal(r.make, 'FORD');
  assert.equal(r.motTests[0].testResult, 'PASSED');
  envOff();
});

test('getMotHistory: 404 returns { found: false }', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => jsonResponse(404, {});
  const r = await dvsaService.getMotHistory('AB12CDE', { fetchImpl, tokenManager: stubTokenManager() });
  assert.deepEqual(r, { found: false });
  envOff();
});

test('getMotHistory: throws on 5xx', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => textResponse(503, 'upstream down');
  await assert.rejects(
    () => dvsaService.getMotHistory('AB12CDE', { fetchImpl, tokenManager: stubTokenManager() }),
    /DVSA API 503/,
  );
  envOff();
});

test('getMotHistory: throws on 400 with structured error', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => textResponse(400, 'bad reg');
  try {
    await dvsaService.getMotHistory('AB12CDE', { fetchImpl, tokenManager: stubTokenManager() });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'DVSA_HTTP');
    assert.equal(err.status, 400);
  }
  envOff();
});

test('getMotHistory: 401 invalidates token and retries once', async () => {
  envOn(); resetDvsaState();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return textResponse(401, 'expired');
    return jsonResponse(200, { registration: 'X', motTests: [] });
  };
  const tm = stubTokenManager();
  const r = await dvsaService.getMotHistory('AB12CDE', { fetchImpl, tokenManager: tm });
  assert.equal(r.found, true);
  assert.equal(calls, 2);
  assert.equal(tm.invalidated(), 1);
  envOff();
});

test('getMotHistory: 401 twice in a row throws (no infinite retry)', async () => {
  envOn(); resetDvsaState();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return textResponse(401, 'still expired'); };
  await assert.rejects(
    () => dvsaService.getMotHistory('AB12CDE', { fetchImpl, tokenManager: stubTokenManager() }),
    /DVSA API 401/,
  );
  assert.equal(calls, 2);
  envOff();
});

test('getMotHistory: timeout produces DVSA_TIMEOUT error', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  try {
    await dvsaService.getMotHistory('AB12CDE', { fetchImpl, tokenManager: stubTokenManager(), timeoutMs: 5 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'DVSA_TIMEOUT');
  }
  envOff();
});

test('getMotHistory: requires registration', async () => {
  envOn(); resetDvsaState();
  await assert.rejects(() => dvsaService.getMotHistory(''), /registration is required/);
  envOff();
});

test('getMotHistory: passes token from manager into Authorization header', async () => {
  envOn(); resetDvsaState();
  let seen = null;
  const fetchImpl = async (_url, init) => {
    seen = init.headers.Authorization;
    return jsonResponse(200, { registration: 'X', motTests: [] });
  };
  await dvsaService.getMotHistory('AB12CDE', { fetchImpl, tokenManager: stubTokenManager('SECRET_TKN') });
  assert.equal(seen, 'Bearer SECRET_TKN');
  envOff();
});

test('getMotHistory: hits configured DVSA_API_BASE', async () => {
  envOn(); resetDvsaState();
  process.env.DVSA_API_BASE = 'https://custom.example.com/v9/trade';
  let seenUrl = null;
  const fetchImpl = async (url) => {
    seenUrl = url;
    return jsonResponse(200, { registration: 'X', motTests: [] });
  };
  await dvsaService.getMotHistory('KR18YYP', { fetchImpl, tokenManager: stubTokenManager() });
  assert.match(seenUrl, /custom\.example\.com\/v9\/trade\/vehicles\/registration\/KR18YYP/);
  envOff();
});

// ---------- fetchMotHistory back-compat ----------

test('fetchMotHistory: returns not-configured envelope when env missing', async () => {
  envOff();
  const r = await dvsaService.fetchMotHistory('AB12CDE');
  assert.equal(r.available, false);
  assert.match(r.error, /not configured/);
});

test('fetchMotHistory: 404 maps to { available: true, notFound: true }', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => jsonResponse(404, {});
  const r = await dvsaService.fetchMotHistory('AB12CDE', { fetchImpl, tokenManager: stubTokenManager() });
  assert.equal(r.available, true);
  assert.equal(r.notFound, true);
  assert.equal(r.data, null);
  envOff();
});

test('fetchMotHistory: 200 maps to legacy [{motTests:[{defects}]}] shape', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => jsonResponse(200, {
    registration: 'X', make: 'FORD',
    motTests: [{
      testResult: 'PASSED', completedDate: '2024-01-01',
      defects: [{ text: 'A', type: 'ADVISORY', dangerous: false }],
    }],
  });
  const r = await dvsaService.fetchMotHistory('X', { fetchImpl, tokenManager: stubTokenManager() });
  assert.equal(r.available, true);
  assert.ok(Array.isArray(r.data));
  assert.equal(r.data[0].make, 'FORD');
  assert.equal(r.data[0].motTests[0].defects.length, 1);
  envOff();
});

test('fetchMotHistory: 5xx maps to { available: false, error }', async () => {
  envOn(); resetDvsaState();
  const fetchImpl = async () => textResponse(502, 'gateway');
  const r = await dvsaService.fetchMotHistory('X', { fetchImpl, tokenManager: stubTokenManager() });
  assert.equal(r.available, false);
  assert.match(r.error, /DVSA API 502/);
  envOff();
});

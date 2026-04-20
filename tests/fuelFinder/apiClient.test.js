'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiClient, extractArray, isRetryable } = require('../../src/services/fuelFinder/apiClient');

function makeHttp(responses) {
  const calls = [];
  return {
    calls,
    get: async (url, opts) => {
      calls.push({ url, opts });
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected GET ${url}`);
      if (next.error) throw next.error;
      return { data: next.body };
    },
  };
}

function makeTokenManager(tokens = ['T1']) {
  let i = 0;
  return {
    getToken: async () => tokens[Math.min(i, tokens.length - 1)],
    invalidate: () => { i++; },
  };
}

test('extractArray unwraps common response shapes', () => {
  assert.deepEqual(extractArray([1, 2]), [1, 2]);
  assert.deepEqual(extractArray({ data: [1] }), [1]);
  assert.deepEqual(extractArray({ data: { stations: [{ x: 1 }] } }), [{ x: 1 }]);
  assert.deepEqual(extractArray({ stations: [3] }), [3]);
  assert.deepEqual(extractArray(null), []);
  assert.deepEqual(extractArray({}), []);
});

test('isRetryable recognises 429/5xx and network errors', () => {
  assert.equal(isRetryable({ response: { status: 429 } }), true);
  assert.equal(isRetryable({ response: { status: 503 } }), true);
  assert.equal(isRetryable({ response: { status: 403 } }), false);
  assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryable({ code: 'ENOENT' }), false);
});

test('getStationsBatch sends bearer token and batch-number param', async () => {
  const http = makeHttp([{ body: { data: [{ node_id: 'a' }, { node_id: 'b' }] } }]);
  const client = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
  });
  const rows = await client.getStationsBatch(1);
  assert.equal(rows.length, 2);
  assert.equal(http.calls[0].opts.headers.Authorization, 'Bearer T1');
  assert.equal(http.calls[0].opts.params['batch-number'], 1);
});

test('getPricesBatch includes effective-start-timestamp', async () => {
  const http = makeHttp([{ body: [] }]);
  const client = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
  });
  await client.getPricesBatch(2, '2026-04-19T12:00:00Z');
  assert.equal(http.calls[0].opts.params['batch-number'], 2);
  assert.equal(http.calls[0].opts.params['effective-start-timestamp'], '2026-04-19T12:00:00Z');
});

test('401 triggers token invalidation and one retry with new token', async () => {
  const err = Object.assign(new Error('401'), { response: { status: 401 } });
  const http = makeHttp([
    { error: err },
    { body: { data: [{ node_id: 'ok' }] } },
  ]);
  const tm = makeTokenManager(['OLD', 'NEW']);
  const client = createApiClient({
    tokenManager: tm,
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
  });
  const rows = await client.getStationsBatch(1);
  assert.equal(rows.length, 1);
  assert.equal(http.calls[0].opts.headers.Authorization, 'Bearer OLD');
  assert.equal(http.calls[1].opts.headers.Authorization, 'Bearer NEW');
});

test('retries on 5xx up to MAX_RETRIES then succeeds', async () => {
  const err500 = Object.assign(new Error('500'), { response: { status: 500 } });
  const http = makeHttp([
    { error: err500 },
    { error: err500 },
    { body: { data: [{ node_id: 'a' }] } },
  ]);
  const client = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
  });
  const rows = await client.getStationsBatch(1);
  assert.equal(rows.length, 1);
  assert.equal(http.calls.length, 3);
});

test('non-retryable errors bubble up', async () => {
  const err403 = Object.assign(new Error('403'), { response: { status: 403 } });
  const http = makeHttp([{ error: err403 }]);
  const client = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
  });
  await assert.rejects(() => client.getStationsBatch(1), /403/);
});

test('routes stations through proxy URL with x-proxy-secret header when proxyUrl set', async () => {
  const http = makeHttp([{ body: { data: [{ node_id: 'a' }] } }]);
  const client = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
    proxyUrl: 'https://proxy.example.com',
    proxySecret: 'supersecret',
  });
  await client.getStationsBatch(3);
  assert.equal(http.calls[0].url, 'https://proxy.example.com/stations');
  assert.equal(http.calls[0].opts.headers['x-proxy-secret'], 'supersecret');
  assert.equal(http.calls[0].opts.headers.Authorization, 'Bearer T1');
  assert.equal(http.calls[0].opts.params['batch-number'], 3);
});

test('routes prices through proxy URL when proxyUrl set', async () => {
  const http = makeHttp([{ body: [] }]);
  const client = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
    proxyUrl: 'https://proxy.example.com',
    proxySecret: 'supersecret',
  });
  await client.getPricesBatch(4, '2026-04-19T12:00:00Z');
  assert.equal(http.calls[0].url, 'https://proxy.example.com/prices');
  assert.equal(http.calls[0].opts.headers['x-proxy-secret'], 'supersecret');
  assert.equal(http.calls[0].opts.params['batch-number'], 4);
  assert.equal(http.calls[0].opts.params['effective-start-timestamp'], '2026-04-19T12:00:00Z');
});

test('direct mode hits fuel-finder.service.gov.uk when proxyUrl not set', async () => {
  const http = makeHttp([{ body: [] }]);
  const client = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
    baseUrl: 'https://www.fuel-finder.service.gov.uk',
    proxyUrl: null,
  });
  await client.getStationsBatch(1);
  assert.equal(http.calls[0].url, 'https://www.fuel-finder.service.gov.uk/api/v1/pfs');
  assert.equal(http.calls[0].opts.headers['x-proxy-secret'], undefined);
});

test('request timeout defaults to 90s and is configurable', async () => {
  const http = makeHttp([{ body: [] }, { body: [] }]);
  const defaultClient = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
  });
  await defaultClient.getStationsBatch(1);
  assert.equal(http.calls[0].opts.timeout, 90000);

  const customClient = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async () => {},
    requestDelayMs: 0,
    requestTimeoutMs: 12345,
  });
  await customClient.getStationsBatch(1);
  assert.equal(http.calls[1].opts.timeout, 12345);
});

test('request delay enforces spacing between calls', async () => {
  const waits = [];
  const http = makeHttp([
    { body: [] },
    { body: [] },
  ]);
  const client = createApiClient({
    tokenManager: makeTokenManager(),
    httpClient: http,
    sleepFn: async (ms) => { waits.push(ms); },
    requestDelayMs: 5000,
  });
  await client.getStationsBatch(1);
  await client.getStationsBatch(2);
  // First call: no prior request, no wait. Second: should wait ~5000ms.
  assert.ok(waits.some((w) => w > 0), 'second call should have waited');
});

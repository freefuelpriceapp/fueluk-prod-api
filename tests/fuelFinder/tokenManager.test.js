'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenManager } = require('../../src/services/fuelFinder/tokenManager');

function makeHttp(responses) {
  const calls = [];
  const impl = {
    post: async (url, body) => {
      calls.push({ url, body });
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected request to ${url}`);
      if (next.error) throw next.error;
      return { data: next.body };
    },
  };
  return { impl, calls };
}

test('generates a fresh token on first call', async () => {
  const { impl, calls } = makeHttp([
    { body: { data: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } } },
  ]);
  const tm = createTokenManager({
    clientId: 'cid', clientSecret: 'csec', httpClient: impl, now: () => 1000,
  });
  const token = await tm.getToken();
  assert.equal(token, 'AT1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generate_access_token$/);
  assert.deepEqual(calls[0].body, { client_id: 'cid', client_secret: 'csec' });
});

test('caches token until near expiry', async () => {
  let tNow = 1000;
  const { impl, calls } = makeHttp([
    { body: { data: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } } },
  ]);
  const tm = createTokenManager({
    clientId: 'cid', clientSecret: 'csec', httpClient: impl, now: () => tNow,
  });
  await tm.getToken();
  tNow += 10 * 1000; // 10s later
  const token2 = await tm.getToken();
  assert.equal(token2, 'AT1');
  assert.equal(calls.length, 1, 'no extra HTTP calls while token valid');
});

test('uses refresh_token near expiry then falls back to generate on refresh failure', async () => {
  let tNow = 1000;
  const { impl, calls } = makeHttp([
    { body: { data: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } } },
    // refresh fails
    { error: Object.assign(new Error('401'), { response: { status: 401 } }) },
    // fallback generate
    { body: { data: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 } } },
  ]);
  const tm = createTokenManager({
    clientId: 'cid', clientSecret: 'csec', httpClient: impl, now: () => tNow,
  });
  await tm.getToken();
  tNow += 3_600_000; // past expiry
  const token2 = await tm.getToken();
  assert.equal(token2, 'AT2');
  assert.equal(calls[1].url.endsWith('regenerate_access_token'), true);
  assert.equal(calls[2].url.endsWith('generate_access_token'), true);
});

test('throws clearly when credentials missing', async () => {
  const { impl } = makeHttp([]);
  const tm = createTokenManager({
    clientId: undefined, clientSecret: undefined, httpClient: impl,
  });
  await assert.rejects(() => tm.getToken(), /credentials not configured/i);
});

test('invalidate forces a new token on next call', async () => {
  let tNow = 1000;
  const { impl, calls } = makeHttp([
    { body: { data: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } } },
    { body: { data: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 } } },
  ]);
  const tm = createTokenManager({
    clientId: 'cid', clientSecret: 'csec', httpClient: impl, now: () => tNow,
  });
  await tm.getToken();
  tm.invalidate();
  const token2 = await tm.getToken();
  assert.equal(token2, 'AT2');
  assert.equal(calls.length, 2);
});

test('routes token requests through proxy URL with x-proxy-secret header when proxyUrl set', async () => {
  const { impl, calls } = makeHttp([
    { body: { data: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } } },
  ]);
  const tm = createTokenManager({
    clientId: 'cid',
    clientSecret: 'csec',
    httpClient: impl,
    now: () => 1000,
    proxyUrl: 'https://proxy.example.com',
    proxySecret: 'supersecret',
  });
  const token = await tm.getToken();
  assert.equal(token, 'AT1');
  assert.equal(calls[0].url, 'https://proxy.example.com/token');
  assert.deepEqual(calls[0].body, { client_id: 'cid', client_secret: 'csec' });
});

test('proxy mode routes refresh through /token too with refresh_token body', async () => {
  let tNow = 1000;
  const posts = [];
  const impl = {
    post: async (url, body, opts) => {
      posts.push({ url, body, headers: opts && opts.headers });
      if (posts.length === 1) {
        return { data: { data: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } } };
      }
      return { data: { data: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 } } };
    },
  };
  const tm = createTokenManager({
    clientId: 'cid',
    clientSecret: 'csec',
    httpClient: impl,
    now: () => tNow,
    proxyUrl: 'https://proxy.example.com',
    proxySecret: 'supersecret',
  });
  await tm.getToken();
  tNow += 3_600_000; // past expiry — triggers refresh
  const t2 = await tm.getToken();
  assert.equal(t2, 'AT2');
  assert.equal(posts[1].url, 'https://proxy.example.com/token');
  assert.deepEqual(posts[1].body, { client_id: 'cid', refresh_token: 'RT1' });
  assert.equal(posts[1].headers['x-proxy-secret'], 'supersecret');
});

test('concurrent getToken calls share a single in-flight request', async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const impl = {
    post: async () => pending,
  };
  const tm = createTokenManager({
    clientId: 'cid', clientSecret: 'csec', httpClient: impl, now: () => 1000,
  });
  const p1 = tm.getToken();
  const p2 = tm.getToken();
  resolve({ data: { data: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 } } });
  const [t1, t2] = await Promise.all([p1, p2]);
  assert.equal(t1, 'AT1');
  assert.equal(t2, 'AT1');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cacheFor, clearCache, cacheSize, _buildKey } = require('../src/middleware/responseCache');

function mockReq({ path = '/x', query = {}, method = 'GET' } = {}) {
  return { path, query, method };
}

function mockRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(name, val) { headers[name] = val; },
    getHeader(name) { return headers[name]; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; this.sent = true; return this; },
    json(body) { this.body = body; this.sent = true; return this; },
    _headers: headers,
  };
  return res;
}

test('buildKey sorts query params and rounds lat/lon to 3dp', () => {
  const k1 = _buildKey({ path: '/x', query: { lon: '-1.234567', lat: '51.987654', fuel: 'petrol' } });
  const k2 = _buildKey({ path: '/x', query: { fuel: 'petrol', lat: '51.987701', lon: '-1.234501' } });
  assert.equal(k1, k2, 'nearby coords within 3dp must produce the same key');
  assert.match(k1, /lat=51\.988/);
  assert.match(k1, /lon=-1\.235/);
});

test('cacheFor serves MISS then HIT within TTL', () => {
  clearCache();
  const mw = cacheFor(60);

  const req1 = mockReq({ path: '/brands' });
  const res1 = mockRes();
  mw(req1, res1, () => {
    res1.json({ brands: ['ESSO'] });
  });
  assert.equal(res1._headers['X-Cache'], 'MISS');
  assert.deepEqual(res1.body, { brands: ['ESSO'] });

  const req2 = mockReq({ path: '/brands' });
  const res2 = mockRes();
  mw(req2, res2, () => {
    assert.fail('handler should not run on cache HIT');
  });
  assert.equal(res2._headers['X-Cache'], 'HIT');
  assert.equal(res2.body, JSON.stringify({ brands: ['ESSO'] }));
});

test('cacheFor does not cache non-2xx responses', () => {
  clearCache();
  const mw = cacheFor(60);

  const req1 = mockReq({ path: '/err' });
  const res1 = mockRes();
  mw(req1, res1, () => {
    res1.status(500).json({ error: 'boom' });
  });
  assert.equal(res1._headers['X-Cache'], 'MISS');

  const req2 = mockReq({ path: '/err' });
  const res2 = mockRes();
  let handlerRan = false;
  mw(req2, res2, () => {
    handlerRan = true;
    res2.status(500).json({ error: 'boom' });
  });
  assert.equal(handlerRan, true, 'no cached entry for 5xx, so handler should run');
  assert.equal(res2._headers['X-Cache'], 'MISS');
});

test('cacheFor skips non-GET methods', () => {
  clearCache();
  const mw = cacheFor(60);

  const req = mockReq({ path: '/post', method: 'POST' });
  const res = mockRes();
  let handlerRan = false;
  mw(req, res, () => { handlerRan = true; });
  assert.equal(handlerRan, true);
  assert.equal(res._headers['X-Cache'], undefined);
});

test('TTL expiry invalidates entries', async () => {
  clearCache();
  const mw = cacheFor(0.05); // 50ms

  const req1 = mockReq({ path: '/ttl' });
  const res1 = mockRes();
  mw(req1, res1, () => { res1.json({ v: 1 }); });
  assert.equal(res1._headers['X-Cache'], 'MISS');

  await new Promise(r => setTimeout(r, 80));

  const req2 = mockReq({ path: '/ttl' });
  const res2 = mockRes();
  let handlerRan = false;
  mw(req2, res2, () => { handlerRan = true; res2.json({ v: 2 }); });
  assert.equal(handlerRan, true, 'expired entry should force a fresh handler run');
  assert.equal(res2._headers['X-Cache'], 'MISS');
});

test('clearCache drops all entries', () => {
  clearCache();
  const mw = cacheFor(60);
  const resA = mockRes();
  mw(mockReq({ path: '/a' }), resA, () => { resA.json({ v: 'a' }); });
  const resB = mockRes();
  mw(mockReq({ path: '/b' }), resB, () => { resB.json({ v: 'b' }); });
  assert.equal(cacheSize(), 2);
  clearCache();
  assert.equal(cacheSize(), 0);
});

test('different query params produce different cache keys', () => {
  clearCache();
  const mw = cacheFor(60);

  const res1 = mockRes();
  mw(mockReq({ path: '/search', query: { q: 'tesco' } }), res1, () => res1.json({ q: 'tesco' }));
  const res2 = mockRes();
  mw(mockReq({ path: '/search', query: { q: 'bp' } }), res2, () => res2.json({ q: 'bp' }));

  assert.equal(res1._headers['X-Cache'], 'MISS');
  assert.equal(res2._headers['X-Cache'], 'MISS');

  const res3 = mockRes();
  let ran = false;
  mw(mockReq({ path: '/search', query: { q: 'tesco' } }), res3, () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(res3._headers['X-Cache'], 'HIT');
});

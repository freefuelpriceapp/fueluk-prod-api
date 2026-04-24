'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { createDeviceRateLimiter, _resetStoreForTests } = require('../src/middleware/rateLimiter');
const { flagPriceLimiter } = require('../src/middleware/flagPriceRateLimit');

function startApp(buildRoutes) {
  const app = express();
  app.use(express.json());
  buildRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function request(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- generic device limiter ---

test('device limiter: 31st call from same device_id within window → 429', async () => {
  _resetStoreForTests();
  const limiter = createDeviceRateLimiter({ deviceMax: 30, deviceWindowMs: 86400000, ipMax: 60, ipWindowMs: 3600000, label: 'test' });
  const { server, port } = await startApp((app) => {
    app.get('/x', limiter, (req, res) => res.json({ ok: true }));
  });
  try {
    const id = 'dev-id-111';
    for (let i = 0; i < 30; i++) {
      const r = await request(port, { path: `/x?_=${i}`, headers: { 'x-device-id': id } });
      assert.equal(r.status, 200, `call ${i + 1} should pass`);
    }
    const blocked = await request(port, { path: '/x?_=31', headers: { 'x-device-id': id } });
    assert.equal(blocked.status, 429);
    assert.equal(typeof blocked.json.retry_after_seconds, 'number');
    assert.ok(blocked.json.retry_after_seconds > 0);
    assert.ok(blocked.json.message && blocked.json.message.length > 0);
  } finally { server.close(); }
});

test('device limiter: a different device_id is independent', async () => {
  _resetStoreForTests();
  const limiter = createDeviceRateLimiter({ deviceMax: 2, deviceWindowMs: 86400000, ipMax: 60, ipWindowMs: 3600000, label: 'test' });
  const { server, port } = await startApp((app) => {
    app.get('/x', limiter, (req, res) => res.json({ ok: true }));
  });
  try {
    // Exhaust device A
    for (let i = 0; i < 2; i++) {
      await request(port, { path: `/x?_=${i}`, headers: { 'x-device-id': 'dev-A' } });
    }
    const aBlocked = await request(port, { path: '/x?_=x', headers: { 'x-device-id': 'dev-A' } });
    assert.equal(aBlocked.status, 429);

    // Device B is independent
    const bOk = await request(port, { path: '/x?_=y', headers: { 'x-device-id': 'dev-B' } });
    assert.equal(bOk.status, 200);
  } finally { server.close(); }
});

test('device limiter: missing device_id uses IP fallback with its own ceiling', async () => {
  _resetStoreForTests();
  const limiter = createDeviceRateLimiter({ deviceMax: 30, deviceWindowMs: 86400000, ipMax: 3, ipWindowMs: 3600000, label: 'test' });
  const { server, port } = await startApp((app) => {
    app.get('/x', limiter, (req, res) => res.json({ ok: true }));
  });
  try {
    const ip = '198.51.100.5';
    for (let i = 0; i < 3; i++) {
      const r = await request(port, { path: `/x?_=${i}`, headers: { 'x-forwarded-for': ip } });
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-ratelimit-scope'], 'ip');
    }
    const blocked = await request(port, { path: '/x?_=4', headers: { 'x-forwarded-for': ip } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.scope, 'ip');
    assert.equal(typeof blocked.json.retry_after_seconds, 'number');
  } finally { server.close(); }
});

test('device limiter: 429 body includes retry_after_seconds integer and human message', async () => {
  _resetStoreForTests();
  const limiter = createDeviceRateLimiter({ deviceMax: 1, deviceWindowMs: 86400000, ipMax: 60, ipWindowMs: 3600000, label: 'test' });
  const { server, port } = await startApp((app) => {
    app.get('/x', limiter, (req, res) => res.json({ ok: true }));
  });
  try {
    await request(port, { path: '/x', headers: { 'x-device-id': 'dev-Z' } });
    const blocked = await request(port, { path: '/x', headers: { 'x-device-id': 'dev-Z' } });
    assert.equal(blocked.status, 429);
    assert.equal(Number.isInteger(blocked.json.retry_after_seconds), true);
    assert.ok(blocked.json.retry_after_seconds > 0);
    assert.equal(typeof blocked.json.message, 'string');
    assert.ok(blocked.json.message.length > 0);
  } finally { server.close(); }
});

// --- flag-price limiter (reads device_id from body) ---

test('flag-price limiter: body.device_id drives the bucket', async () => {
  _resetStoreForTests();
  const { server, port } = await startApp((app) => {
    // Minimal handler — we only care about the limiter here, not the real service.
    app.post('/s/:id/flag-price', flagPriceLimiter, (req, res) => res.json({ ok: true }));
  });
  try {
    // Device cap for flag-price is 50/day. Make 50 go through, 51st blocked.
    const deviceId = 'fp-dev-1';
    for (let i = 0; i < 50; i++) {
      const r = await request(port, {
        method: 'POST', path: '/s/abc/flag-price',
        body: { device_id: deviceId, fuel_type: 'E10' },
      });
      assert.equal(r.status, 200, `call ${i + 1}`);
    }
    const blocked = await request(port, {
      method: 'POST', path: '/s/abc/flag-price',
      body: { device_id: deviceId, fuel_type: 'E10' },
    });
    assert.equal(blocked.status, 429);
    assert.equal(typeof blocked.json.retry_after_seconds, 'number');
  } finally { server.close(); }
});

test('flag-price limiter: different device_id not blocked when another is exhausted', async () => {
  _resetStoreForTests();
  const { server, port } = await startApp((app) => {
    app.post('/s/:id/flag-price', flagPriceLimiter, (req, res) => res.json({ ok: true }));
  });
  try {
    const A = 'fp-exhaust-A';
    for (let i = 0; i < 50; i++) {
      await request(port, {
        method: 'POST', path: '/s/abc/flag-price',
        body: { device_id: A, fuel_type: 'E10' },
      });
    }
    const aBlocked = await request(port, {
      method: 'POST', path: '/s/abc/flag-price',
      body: { device_id: A, fuel_type: 'E10' },
    });
    assert.equal(aBlocked.status, 429);

    const bOk = await request(port, {
      method: 'POST', path: '/s/abc/flag-price',
      body: { device_id: 'fp-fresh-B', fuel_type: 'E10' },
    });
    assert.equal(bOk.status, 200);
  } finally { server.close(); }
});

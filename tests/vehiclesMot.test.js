'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const vehiclesRoute = require('../src/routes/vehicles');
const dvsaService = require('../src/services/dvsaService');
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

function envOn() {
  process.env.DVSA_CLIENT_ID = 'cid';
  process.env.DVSA_CLIENT_SECRET = 'csec';
  process.env.DVSA_API_KEY = 'apikey';
  process.env.DVSA_TOKEN_URL = 'https://login.example.com/token';
}
function envOff() {
  delete process.env.DVSA_CLIENT_ID;
  delete process.env.DVSA_CLIENT_SECRET;
  delete process.env.DVSA_API_KEY;
  delete process.env.DVSA_TOKEN_URL;
}

function reset() {
  vehiclesRoute.clearCache();
  _resetStoreForTests();
}

test('GET /mot: 400 on invalid reg', async () => {
  envOn(); reset();
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/mot?reg=!!!');
    assert.equal(r.status, 400);
  } finally { server.close(); envOff(); }
});

test('GET /mot: 503 when DVSA not configured', async () => {
  envOff(); reset();
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/mot?reg=AB12CDE');
    assert.equal(r.status, 503);
    assert.match(r.json.error, /not configured/);
  } finally { server.close(); }
});

test('GET /mot: 200 returns parsed MOT history', async () => {
  envOn(); reset();
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async (reg) => ({
    found: true, registration: reg, make: 'FORD', model: 'FOCUS',
    firstUsedDate: '2018-04-01', fuelType: 'PETROL', primaryColour: 'BLUE',
    motTests: [{ completedDate: '2024-08-10', testResult: 'PASSED', expiryDate: '2025-08-09',
      odometerValue: 42150, odometerUnit: 'mi', motTestNumber: '123', rfrAndComments: [] }],
  });
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/mot?reg=KR18YYP', { 'x-device-id': 'dev1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.found, true);
    assert.equal(r.json.registration, 'KR18YYP');
    assert.equal(r.json.make, 'FORD');
    assert.equal(r.json.motTests.length, 1);
    assert.equal(r.headers['x-cache'], 'MISS');
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

test('GET /mot: 200 with found=false on DVSA 404', async () => {
  envOn(); reset();
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async () => ({ found: false });
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/mot?reg=AB12CDE', { 'x-device-id': 'dev2' });
    assert.equal(r.status, 200);
    assert.equal(r.json.found, false);
    assert.equal(r.json.reg, 'AB12CDE');
    assert.equal(r.json.reason, 'no_mot_records');
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

test('GET /mot: 502 on DVSA API error', async () => {
  envOn(); reset();
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async () => { const e = new Error('boom'); e.code = 'DVSA_HTTP'; e.status = 500; throw e; };
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/mot?reg=AB12CDE', { 'x-device-id': 'dev3' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'DVSA API error');
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

test('GET /mot: caches result for repeat requests (X-Cache: HIT)', async () => {
  envOn(); reset();
  let calls = 0;
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async (reg) => { calls += 1; return { found: true, registration: reg, motTests: [] }; };
  const { server, port } = await startApp();
  try {
    const a = await fetchJson(port, '/api/v1/vehicles/mot?reg=KR18YYP', { 'x-device-id': 'dev-cache' });
    const b = await fetchJson(port, '/api/v1/vehicles/mot?reg=KR18YYP', { 'x-device-id': 'dev-cache' });
    assert.equal(a.headers['x-cache'], 'MISS');
    assert.equal(b.headers['x-cache'], 'HIT');
    assert.equal(calls, 1);
    const c = await fetchJson(port, '/api/v1/vehicles/mot?reg=KR18YYP&refresh=true', { 'x-device-id': 'dev-cache' });
    assert.equal(c.headers['x-cache'], 'BYPASS');
    assert.equal(calls, 2);
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

test('GET /mot: per-device cap is 20/24h (21st request returns 429)', async () => {
  envOn(); reset();
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async (reg) => ({ found: true, registration: reg, motTests: [] });
  const { server, port } = await startApp();
  try {
    const dev = 'dev-mot-limit';
    let limited = null;
    for (let i = 0; i < 21; i++) {
      const r = await fetchJson(port, `/api/v1/vehicles/mot?reg=AB12CDE&_i=${i}`, { 'x-device-id': dev });
      if (r.status === 429) { limited = r; break; }
    }
    assert.ok(limited, 'expected a 429 on the 21st request');
    assert.ok(limited.json.retry_after_seconds > 0);
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

test('GET /mot: a fresh device is unaffected when another is exhausted', async () => {
  envOn(); reset();
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async (reg) => ({ found: true, registration: reg, motTests: [] });
  const { server, port } = await startApp();
  try {
    for (let i = 0; i < 21; i++) {
      await fetchJson(port, `/api/v1/vehicles/mot?reg=AB12CDE&_i=${i}`, { 'x-device-id': 'devA' });
    }
    const blocked = await fetchJson(port, '/api/v1/vehicles/mot?reg=AB12CDE', { 'x-device-id': 'devA' });
    assert.equal(blocked.status, 429);
    const fresh = await fetchJson(port, '/api/v1/vehicles/mot?reg=AB12CDE', { 'x-device-id': 'devB' });
    assert.equal(fresh.status, 200);
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

test('GET /mot: missing device_id falls back to per-IP scope', async () => {
  envOn(); reset();
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async (reg) => ({ found: true, registration: reg, motTests: [] });
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/mot?reg=AB12CDE', { 'x-forwarded-for': '203.0.113.10' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-ratelimit-scope'], 'ip');
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

test('GET /mot: device_id query param works equivalently to header', async () => {
  envOn(); reset();
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async (reg) => ({ found: true, registration: reg, motTests: [] });
  const { server, port } = await startApp();
  try {
    const r = await fetchJson(port, '/api/v1/vehicles/mot?reg=AB12CDE&device_id=qp-mot');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-ratelimit-scope'], 'device');
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

test('GET /mot: clearCache also clears MOT cache', async () => {
  envOn(); reset();
  let calls = 0;
  const original = dvsaService.getMotHistory;
  dvsaService.getMotHistory = async (reg) => { calls += 1; return { found: true, registration: reg, motTests: [] }; };
  const { server, port } = await startApp();
  try {
    await fetchJson(port, '/api/v1/vehicles/mot?reg=KR18YYP', { 'x-device-id': 'devC' });
    vehiclesRoute.clearCache();
    await fetchJson(port, '/api/v1/vehicles/mot?reg=KR18YYP', { 'x-device-id': 'devC' });
    assert.equal(calls, 2);
  } finally { dvsaService.getMotHistory = original; server.close(); envOff(); }
});

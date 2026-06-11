'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Wave A.10 \u2014 admin-trigger endpoints for Fuel Finder price/station sync,
 * plus structured error serialisation so the actual upstream failure is\n * surfaced (status, body, headers) rather than swallowed in logs.\n */

// Stub the fuelFinder service before route registration.
const ffPath = require.resolve('../src/services/fuelFinder');
const stub = {
  isFlagEnabled: () => true,
  hasCredentials: () => true,
  runPriceSyncOnce: async () => ({ ok: true, summary: { batches: 1, pricesSeen: 42, stationsUpdated: 10 } }),
  runStationSyncOnce: async () => ({ ok: true, summary: { stationsSeen: 11926, stationsUpdated: 1 } }),
  serialiseError: (err) => ({ message: err.message }),
};
require('module')._cache[ffPath] = { exports: stub };

const express = require('express');
const router = require('../src/routes/diagnostics');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/diagnostics', router);
  return app;
}

async function call(app, method, path, headers = {}) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request(
        { method, host: '127.0.0.1', port, path, headers },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            server.close();
            try { resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }); }
            catch (e) { resolve({ status: res.statusCode, body }); }
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

test('price sync trigger returns 503 when ADMIN_API_TOKEN unset', async () => {
  delete process.env.ADMIN_API_TOKEN;
  const r = await call(buildApp(), 'POST', '/api/v1/diagnostics/fuel-finder/run-price-sync');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'admin endpoint disabled');
});

test('price sync trigger rejects without X-Admin-Token', async () => {
  process.env.ADMIN_API_TOKEN = 'secret-token';
  const r = await call(buildApp(), 'POST', '/api/v1/diagnostics/fuel-finder/run-price-sync');
  assert.equal(r.status, 401);
});

test('price sync trigger rejects wrong token', async () => {
  process.env.ADMIN_API_TOKEN = 'secret-token';
  const r = await call(buildApp(), 'POST', '/api/v1/diagnostics/fuel-finder/run-price-sync',
    { 'X-Admin-Token': 'WRONG' });
  assert.equal(r.status, 401);
});

test('price sync trigger runs and returns ok summary with valid token', async () => {
  process.env.ADMIN_API_TOKEN = 'secret-token';
  const r = await call(buildApp(), 'POST', '/api/v1/diagnostics/fuel-finder/run-price-sync',
    { 'X-Admin-Token': 'secret-token' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.result.summary.pricesSeen, 42);
});

test('price sync trigger returns 502 with structured upstream error on failure', async () => {
  process.env.ADMIN_API_TOKEN = 'secret-token';
  stub.runPriceSyncOnce = async () => ({
    ok: false,
    error: {
      message: 'Request failed with status code 403',
      upstream: { status: 403, statusText: 'Forbidden', body: { error: 'invalid_token' } },
    },
  });
  const r = await call(buildApp(), 'POST', '/api/v1/diagnostics/fuel-finder/run-price-sync',
    { 'X-Admin-Token': 'secret-token' });
  assert.equal(r.status, 502);
  assert.equal(r.body.success, false);
  assert.equal(r.body.result.error.upstream.status, 403);
  assert.deepEqual(r.body.result.error.upstream.body, { error: 'invalid_token' });
});

test('station sync trigger exists and accepts admin token', async () => {
  process.env.ADMIN_API_TOKEN = 'secret-token';
  stub.runStationSyncOnce = async () => ({ ok: true, summary: { stationsSeen: 11926 } });
  const r = await call(buildApp(), 'POST', '/api/v1/diagnostics/fuel-finder/run-station-sync',
    { 'X-Admin-Token': 'secret-token' });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.summary.stationsSeen, 11926);
});

test('serialiseError captures axios upstream response details', () => {
  // Use the real module here \u2014 unwire the stub for this assertion.
  delete require('module')._cache[ffPath];
  const { serialiseError } = require('../src/services/fuelFinder');
  const fakeAxiosErr = Object.assign(new Error('Request failed with status code 401'), {
    code: null,
    name: 'AxiosError',
    response: {
      status: 401,
      statusText: 'Unauthorized',
      data: { error: 'invalid_grant', error_description: 'Token expired' },
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' },
    },
    config: { method: 'get', url: 'https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices', params: { 'batch-number': 1 } },
  });
  const out = serialiseError(fakeAxiosErr);
  assert.equal(out.message, 'Request failed with status code 401');
  assert.equal(out.upstream.status, 401);
  assert.deepEqual(out.upstream.body, { error: 'invalid_grant', error_description: 'Token expired' });
  assert.equal(out.upstream.headers['www-authenticate'], 'Bearer error="invalid_token"');
  assert.equal(out.request.url, 'https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices');
  assert.equal(out.request.params['batch-number'], 1);
});

'use strict';
/**
 * Route tests for src/routes/alerts.js, focused on the bulk-delete endpoint.
 * Pool is injected by stubbing src/config/db before requiring the route.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const path = require('path');

// Stub ../src/config/db BEFORE requiring the alerts route so getPool() returns our fake.
const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'config', 'db'));
let nextQuery = null; // (sql, params) => { rows } | throws

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    initPool: async () => {},
    getPool: () => ({
      query: async (sql, params) => {
        if (typeof nextQuery !== 'function') {
          throw new Error('no query handler set for this test');
        }
        return nextQuery(sql, params);
      },
    }),
  },
};

const alertsRouter = require('../src/routes/alerts');

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/alerts', alertsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) { /* noop */ }
          resolve({ status: res.statusCode, body: data, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('DELETE /api/v1/alerts/token/:token deactivates all alerts and returns count', async () => {
  const { server, port } = await startApp();
  try {
    const captured = {};
    nextQuery = (sql, params) => {
      captured.sql = sql;
      captured.params = params;
      return { rows: [{ id: 11 }, { id: 12 }, { id: 13 }] };
    };

    const res = await request(port, 'DELETE', '/api/v1/alerts/token/ExponentPushToken%5Babc123%5D');

    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { success: true, deleted: 3 });
    // Express decodes URL params, so the handler should receive the decoded token.
    assert.equal(captured.params[0], 'ExponentPushToken[abc123]');
    assert.match(captured.sql, /UPDATE price_alerts/);
    assert.match(captured.sql, /SET active = false/);
    assert.match(captured.sql, /WHERE device_token = \$1/);
  } finally {
    server.close();
    nextQuery = null;
  }
});

test('DELETE /api/v1/alerts/token/:token returns 404 when no alerts exist for that token', async () => {
  const { server, port } = await startApp();
  try {
    nextQuery = () => ({ rows: [] });

    const res = await request(port, 'DELETE', '/api/v1/alerts/token/unknown-token');

    assert.equal(res.status, 404);
    assert.ok(res.json && res.json.error, 'expected error body');
  } finally {
    server.close();
    nextQuery = null;
  }
});

test('DELETE /api/v1/alerts/:id still works (single-alert path not shadowed by bulk path)', async () => {
  const { server, port } = await startApp();
  try {
    nextQuery = (_sql, params) => ({ rows: [{ id: Number(params[0]) }] });

    const res = await request(port, 'DELETE', '/api/v1/alerts/42');

    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { deleted: true, id: 42 });
  } finally {
    server.close();
    nextQuery = null;
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const apiVersionMiddleware = require('../src/middleware/apiVersion');
const { deprecated, CURRENT_VERSION, MIN_VERSION } = require('../src/middleware/apiVersion');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function startApp(buildRoutes) {
  const app = express();
  app.use('/api/v1', apiVersionMiddleware);
  buildRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function fetchJson(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('apiVersion middleware sets version + min-version + empty deprecation headers', async () => {
  const { server, port } = await startApp((app) => {
    app.get('/api/v1/ping', (req, res) => res.json({ ok: true }));
  });
  try {
    const res = await fetchJson(port, '/api/v1/ping');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-api-version'], String(CURRENT_VERSION));
    assert.equal(res.headers['x-api-min-version'], String(MIN_VERSION));
    assert.equal(res.headers['x-api-deprecation'], '');
  } finally {
    server.close();
  }
});

test('apiVersion middleware sets X-Request-Id as a valid UUID and exposes it on req.id', async () => {
  let captured;
  const { server, port } = await startApp((app) => {
    app.get('/api/v1/echo', (req, res) => {
      captured = req.id;
      res.json({ id: req.id });
    });
  });
  try {
    const res = await fetchJson(port, '/api/v1/echo');
    assert.equal(res.status, 200);
    const headerId = res.headers['x-request-id'];
    assert.ok(UUID_RE.test(headerId), `expected uuid, got ${headerId}`);
    assert.equal(headerId, captured, 'req.id should match X-Request-Id header');
  } finally {
    server.close();
  }
});

test('apiVersion middleware emits a unique request id per request', async () => {
  const { server, port } = await startApp((app) => {
    app.get('/api/v1/ping', (req, res) => res.json({ ok: true }));
  });
  try {
    const a = await fetchJson(port, '/api/v1/ping');
    const b = await fetchJson(port, '/api/v1/ping');
    assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
  } finally {
    server.close();
  }
});

test('deprecated() decorator sets Sunset and deprecation headers', async () => {
  const { server, port } = await startApp((app) => {
    app.get(
      '/api/v1/old',
      deprecated('2026-07-01', 'Use /new-endpoint instead'),
      (req, res) => res.json({ ok: true }),
    );
  });
  try {
    const res = await fetchJson(port, '/api/v1/old');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-api-deprecation'], 'true');
    assert.equal(res.headers['x-api-deprecation-message'], 'Use /new-endpoint instead');
    assert.ok(res.headers['sunset'], 'Sunset header should be set');
    // Should be a valid HTTP date
    assert.ok(!Number.isNaN(Date.parse(res.headers['sunset'])));
  } finally {
    server.close();
  }
});

test('client X-Api-Version header is parsed onto req.clientApiVersion', async () => {
  let captured;
  const { server, port } = await startApp((app) => {
    app.get('/api/v1/who', (req, res) => {
      captured = req.clientApiVersion;
      res.json({ v: req.clientApiVersion });
    });
  });
  try {
    const res = await fetchJson(port, '/api/v1/who', { 'X-Api-Version': '2' });
    assert.equal(res.status, 200);
    assert.equal(captured, 2);
    assert.equal(JSON.parse(res.body).v, 2);
  } finally {
    server.close();
  }
});

test('missing X-Api-Version header leaves req.clientApiVersion undefined', async () => {
  let captured = 'sentinel';
  const { server, port } = await startApp((app) => {
    app.get('/api/v1/who', (req, res) => {
      captured = req.clientApiVersion;
      res.json({});
    });
  });
  try {
    await fetchJson(port, '/api/v1/who');
    assert.equal(captured, undefined);
  } finally {
    server.close();
  }
});

'use strict';

/**
 * receipts.test.js
 * Phase 2B — receipt OCR + ground-truth endpoint tests
 *
 * Covers:
 *  - POST /receipts/ocr: happy path (mocked Textract), rate limit, image too large,
 *    missing image, partial OCR (422), Textract service error (503)
 *  - POST /receipts/groundtruth: happy path, full postcode rejection, invalid brand,
 *    invalid p/L, invalid fuel_type, future date, >30 days date, missing fields
 *  - GET /diagnostics/groundtruth: returns aggregate shape
 *  - Textract service unit tests: parseDate, resolveFuelType, matchBrand, parseTextractResponse
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const crypto = require('crypto');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startApp(buildRoutes) {
  const app = express();
  app.use(express.json());
  buildRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function request(port, { method = 'POST', path, headers = {}, body, rawBody, rawContentType } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    let contentType = null;
    if (rawBody) {
      payload = rawBody;
      contentType = rawContentType || 'application/octet-stream';
    } else if (body) {
      payload = JSON.stringify(body);
      contentType = 'application/json';
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload
            ? {
                'content-type': contentType,
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Build a minimal multipart/form-data body for a single file field
function buildMultipart(fieldName, fileBuffer, mimeType, boundary) {
  const bnd = boundary || 'TESTBOUNDARY1234567890';
  const parts = [
    `--${bnd}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="test.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];
  const closing = `\r\n--${bnd}--\r\n`;
  const headerBuf = Buffer.from(parts[0]);
  const closingBuf = Buffer.from(closing);
  return {
    boundary: bnd,
    body: Buffer.concat([headerBuf, fileBuffer, closingBuf]),
  };
}

// Minimal valid JPEG (1×1 white pixel)
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB/8QAHxAAAQMFAQEAAAAAAAAAAAAAAQIDBREhMQQS/8QAFQEBAQAAAAAAAAAAAAAAAAAAAQL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwABbAAAAAAAAAAA==',
  'base64'
);

// ─── Textract service unit tests ──────────────────────────────────────────────

const {
  matchBrand,
  resolveFuelType,
  parseDate,
  parseTextractResponse,
  _setClientForTests,
} = require('../src/services/textractService');

test('matchBrand: returns canonical brand for known name', () => {
  assert.equal(matchBrand('ASDA EXPRESS BIRMINGHAM'), 'Asda Express');
  assert.equal(matchBrand('SHELL GARAGE'), 'Shell');
  assert.equal(matchBrand('TESCO PETROL'), 'Tesco');
  assert.equal(matchBrand('BP STATION'), 'BP');
  assert.equal(matchBrand('MORRISONS'), 'Morrisons');
  assert.equal(matchBrand('ESSO FORECOURT'), 'Esso');
});

test('matchBrand: returns null for unknown name', () => {
  assert.equal(matchBrand('JOE\'S DODGY PETROL'), null);
  assert.equal(matchBrand(null), null);
  assert.equal(matchBrand(''), null);
});

test('resolveFuelType: detects unleaded', () => {
  assert.equal(resolveFuelType('E10 UNLEADED'), 'unleaded');
  assert.equal(resolveFuelType('UNLEADED 95'), 'unleaded');
  assert.equal(resolveFuelType('PETROL E5'), 'unleaded');
});

test('resolveFuelType: detects diesel', () => {
  assert.equal(resolveFuelType('B7 DIESEL'), 'diesel');
  assert.equal(resolveFuelType('DIESEL'), 'diesel');
});

test('resolveFuelType: detects super_unleaded', () => {
  assert.equal(resolveFuelType('SUPER UNLEADED'), 'super_unleaded');
  assert.equal(resolveFuelType('V-POWER PETROL'), 'super_unleaded');
});

test('resolveFuelType: detects premium_diesel', () => {
  assert.equal(resolveFuelType('PREMIUM DIESEL'), 'premium_diesel');
  assert.equal(resolveFuelType('ULTIMATE DIESEL'), 'premium_diesel');
  assert.equal(resolveFuelType('V-POWER DIESEL'), 'premium_diesel');
});

test('resolveFuelType: returns null for unrecognized text', () => {
  assert.equal(resolveFuelType('CAR WASH'), null);
  assert.equal(resolveFuelType(null), null);
  assert.equal(resolveFuelType(''), null);
});

test('parseDate: ISO date passthrough', () => {
  assert.equal(parseDate('2026-05-07'), '2026-05-07');
});

test('parseDate: UK format dd/mm/yyyy', () => {
  assert.equal(parseDate('07/05/2026'), '2026-05-07');
});

test('parseDate: UK format dd-mm-yyyy', () => {
  assert.equal(parseDate('07-05-2026'), '2026-05-07');
});

test('parseDate: returns null for garbage', () => {
  assert.equal(parseDate('not-a-date'), null);
  assert.equal(parseDate(null), null);
});

test('parseTextractResponse: extracts fields from mock Textract response', () => {
  const mockResponse = {
    ExpenseDocuments: [{
      SummaryFields: [
        { Type: { Text: 'VENDOR_NAME' }, ValueDetection: { Text: 'ASDA EXPRESS STORE', Confidence: 95 } },
        { Type: { Text: 'TOTAL' }, ValueDetection: { Text: '£58.74', Confidence: 92 } },
        { Type: { Text: 'INVOICE_RECEIPT_DATE' }, ValueDetection: { Text: '07/05/2026', Confidence: 90 } },
      ],
      LineItemGroups: [{
        LineItems: [{
          LineItemExpenseFields: [
            { Type: { Text: 'ITEM' }, ValueDetection: { Text: 'UNLEADED E10', Confidence: 88 } },
            { Type: { Text: 'QUANTITY' }, ValueDetection: { Text: '38.42', Confidence: 85 } },
            { Type: { Text: 'UNIT_PRICE' }, ValueDetection: { Text: '152.9', Confidence: 87 } },
            { Type: { Text: 'PRICE' }, ValueDetection: { Text: '58.74', Confidence: 90 } },
          ]
        }]
      }]
    }]
  };
  const { data } = parseTextractResponse(mockResponse);
  assert.equal(data.stationName, 'ASDA EXPRESS STORE');
  assert.equal(data.stationBrand, 'Asda Express');
  assert.equal(data.fuelType, 'unleaded');
  assert.equal(data.litres, 38.42);
  assert.equal(data.pricePerLitre, 152.9);
  assert.ok(data.totalPaid > 0);
  assert.equal(data.receiptDate, '2026-05-07');
  assert.ok(data.ocrConfidence > 0 && data.ocrConfidence <= 1);
});

test('parseTextractResponse: derives pricePerLitre from total + litres', () => {
  const mockResponse = {
    ExpenseDocuments: [{
      SummaryFields: [
        { Type: { Text: 'TOTAL' }, ValueDetection: { Text: '£50.00', Confidence: 90 } },
      ],
      LineItemGroups: [{
        LineItems: [{
          LineItemExpenseFields: [
            { Type: { Text: 'ITEM' }, ValueDetection: { Text: 'DIESEL', Confidence: 85 } },
            { Type: { Text: 'QUANTITY' }, ValueDetection: { Text: '32.68', Confidence: 82 } },
          ]
        }]
      }]
    }]
  };
  const { data } = parseTextractResponse(mockResponse);
  assert.equal(data.fuelType, 'diesel');
  assert.ok(data.pricePerLitre != null, 'pricePerLitre should be derived');
  assert.ok(data.pricePerLitre > 100, 'pricePerLitre should be in pence/L range');
});

test('parseTextractResponse: handles empty response gracefully', () => {
  const { data, partial } = parseTextractResponse({ ExpenseDocuments: [] });
  assert.equal(typeof data, 'object');
  assert.equal(partial, true);
});

// ─── POST /receipts/ocr integration tests ────────────────────────────────────

const receiptsRouter = require('../src/routes/receipts');

function buildReceiptsApp() {
  const app = express();
  app.use('/api/v1/receipts', receiptsRouter);
  return app;
}

test('POST /receipts/ocr: 422 when no image field', async () => {
  receiptsRouter._resetOcrStore();
  const { server, port } = await startApp((app) => {
    app.use('/api/v1/receipts', receiptsRouter);
  });
  try {
    const r = await request(port, {
      method: 'POST',
      path: '/api/v1/receipts/ocr',
      body: {},
    });
    // multer won't parse JSON as multipart, so will get 422
    assert.ok(r.status === 422 || r.status === 400, `Expected 422 or 400, got ${r.status}`);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test('POST /receipts/ocr: 413 when image too large', async () => {
  receiptsRouter._resetOcrStore();
  const { server, port } = await startApp((app) => {
    app.use('/api/v1/receipts', receiptsRouter);
  });
  try {
    // Build oversized multipart: 9 MB
    const bigBuffer = Buffer.alloc(9 * 1024 * 1024, 0xff);
    const { boundary, body } = buildMultipart('image', bigBuffer, 'image/jpeg');
    const r = await request(port, {
      method: 'POST',
      path: '/api/v1/receipts/ocr',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    });
    assert.equal(r.status, 413, `Expected 413, got ${r.status}`);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test('POST /receipts/ocr: 429 after 5 calls from same device', async () => {
  receiptsRouter._resetOcrStore();

  // Mock Textract to return a partial result so OCR fails without actual AWS call
  const textractSvc = require('../src/services/textractService');
  const original = textractSvc.analyzeReceiptImage;
  const partialErr = new Error('ocr_failed');
  partialErr.partial = { ocrConfidence: 0.1 };
  textractSvc.analyzeReceiptImage = async () => { throw partialErr; };

  const { server, port } = await startApp((app) => {
    app.use('/api/v1/receipts', receiptsRouter);
  });
  try {
    const deviceId = 'ocr-test-device-' + Date.now();
    const { boundary, body } = buildMultipart('image', TINY_JPEG, 'image/jpeg');
    const headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-device-id': deviceId,
    };

    // 5 calls should be allowed (may return 422 due to mocked partial error)
    for (let i = 0; i < 5; i++) {
      const r = await request(port, {
        method: 'POST',
        path: '/api/v1/receipts/ocr',
        headers,
        rawBody: body,
      });
      assert.notEqual(r.status, 429, `Call ${i + 1} should not be rate-limited`);
    }

    // 6th call should be rate-limited
    const r = await request(port, {
      method: 'POST',
      path: '/api/v1/receipts/ocr',
      headers,
      rawBody: body,
    });
    assert.equal(r.status, 429, 'Expected 429 on 6th call');
    assert.ok(r.json && r.json.error === 'rate_limited', 'Should have rate_limited error');
  } finally {
    textractSvc.analyzeReceiptImage = original;
    await new Promise((res) => server.close(res));
  }
});

test('POST /receipts/ocr: 422 when Textract returns partial data', async () => {
  receiptsRouter._resetOcrStore();

  const textractSvc = require('../src/services/textractService');
  const original = textractSvc.analyzeReceiptImage;
  const partialErr = new Error('OCR produced insufficient data');
  partialErr.partial = { stationBrand: 'Shell', ocrConfidence: 0.3 };
  textractSvc.analyzeReceiptImage = async () => { throw partialErr; };

  const { server, port } = await startApp((app) => {
    app.use('/api/v1/receipts', receiptsRouter);
  });
  try {
    const { boundary, body } = buildMultipart('image', TINY_JPEG, 'image/jpeg');
    const r = await request(port, {
      method: 'POST',
      path: '/api/v1/receipts/ocr',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    });
    assert.equal(r.status, 422);
    assert.ok(r.json);
    assert.equal(r.json.error, 'ocr_failed');
    assert.ok(r.json.partial, 'Should include partial data');
  } finally {
    textractSvc.analyzeReceiptImage = original;
    await new Promise((res) => server.close(res));
  }
});

test('POST /receipts/ocr: 503 when Textract service unavailable', async () => {
  receiptsRouter._resetOcrStore();

  const textractSvc = require('../src/services/textractService');
  const original = textractSvc.analyzeReceiptImage;
  const svcErr = new Error('Textract service unavailable');
  svcErr.isServiceError = true;
  textractSvc.analyzeReceiptImage = async () => { throw svcErr; };

  const { server, port } = await startApp((app) => {
    app.use('/api/v1/receipts', receiptsRouter);
  });
  try {
    const { boundary, body } = buildMultipart('image', TINY_JPEG, 'image/jpeg');
    const r = await request(port, {
      method: 'POST',
      path: '/api/v1/receipts/ocr',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    });
    assert.equal(r.status, 503);
    assert.ok(r.json);
    assert.equal(r.json.error, 'textract_unavailable');
  } finally {
    textractSvc.analyzeReceiptImage = original;
    await new Promise((res) => server.close(res));
  }
});

test('POST /receipts/ocr: 200 on successful OCR', async () => {
  receiptsRouter._resetOcrStore();

  const textractSvc = require('../src/services/textractService');
  const original = textractSvc.analyzeReceiptImage;
  textractSvc.analyzeReceiptImage = async () => ({
    stationName: 'ASDA EXPRESS BIRMINGHAM',
    stationBrand: 'Asda',
    fuelType: 'unleaded',
    litres: 38.42,
    pricePerLitre: 152.9,
    totalPaid: 5874,
    receiptDate: '2026-05-07',
    ocrConfidence: 0.84,
  });

  const { server, port } = await startApp((app) => {
    app.use('/api/v1/receipts', receiptsRouter);
  });
  try {
    const { boundary, body } = buildMultipart('image', TINY_JPEG, 'image/jpeg');
    const r = await request(port, {
      method: 'POST',
      path: '/api/v1/receipts/ocr',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    });
    assert.equal(r.status, 200);
    assert.ok(r.json);
    assert.equal(r.json.stationName, 'ASDA EXPRESS BIRMINGHAM');
    assert.equal(r.json.stationBrand, 'Asda');
    assert.equal(r.json.fuelType, 'unleaded');
    assert.equal(r.json.litres, 38.42);
    assert.equal(r.json.pricePerLitre, 152.9);
    assert.equal(r.json.totalPaid, 5874);
    assert.equal(r.json.receiptDate, '2026-05-07');
    assert.equal(r.json.ocrConfidence, 0.84);
  } finally {
    textractSvc.analyzeReceiptImage = original;
    await new Promise((res) => server.close(res));
  }
});

// ─── POST /receipts/groundtruth integration tests ─────────────────────────────

// Mock the DB pool for groundtruth tests
const groundtruthRepo = require('../src/repositories/groundtruthRepository');

function mockGroundtruthRepo(fn) {
  const original = groundtruthRepo.insertGroundTruth;
  groundtruthRepo.insertGroundTruth = fn || (async () => ({ id: 'test-uuid', ingested_at: new Date() }));
  return () => { groundtruthRepo.insertGroundTruth = original; };
}

function validGroundtruthBody(overrides = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    brand: 'Asda',
    postcode_outcode: 'B10',
    p_per_l: 152.9,
    fuel_type: 'unleaded',
    receipt_date: today,
    ...overrides,
  };
}

test('POST /receipts/groundtruth: 400 when brand missing', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ brand: undefined }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'brand'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for unknown brand', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ brand: 'UnknownBrandXYZ' }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'brand'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for full postcode (with inner code)', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    // Full postcode: B10 0AE
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ postcode_outcode: 'B10 0AE' }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'postcode_outcode'), 'Should reject full postcode');
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for another full postcode format', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ postcode_outcode: 'SW1A 2AA' }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'postcode_outcode'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for invalid outcode format', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ postcode_outcode: '123INVALID' }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'postcode_outcode'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: accepts valid single-letter-digit outcode', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    // M1, E1, W1 etc.
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ postcode_outcode: 'M1' }) });
    assert.ok(r.status === 204 || r.status === 500, `Expected 204 or 500 (DB), got ${r.status}`);
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for p_per_l below 80', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ p_per_l: 50 }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'p_per_l'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for p_per_l above 300', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ p_per_l: 400 }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'p_per_l'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for invalid fuel_type', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ fuel_type: 'hydrogen' }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'fuel_type'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for receipt_date in the future', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ receipt_date: future }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'receipt_date'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 400 for receipt_date >30 days ago', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const old = new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ receipt_date: old }) });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.some((e) => e.field === 'receipt_date'));
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 204 on valid submission', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody() });
    assert.equal(r.status, 204);
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: accepts all valid fuel types', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    for (const ft of ['unleaded', 'super_unleaded', 'diesel', 'premium_diesel']) {
      const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ fuel_type: ft }) });
      assert.equal(r.status, 204, `fuel_type "${ft}" should be accepted`);
    }
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: 429 after 10 calls from same device', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const deviceId = 'gt-test-device-' + Date.now();
    // 10 calls should pass
    for (let i = 0; i < 10; i++) {
      const r = await request(port, {
        path: '/api/v1/receipts/groundtruth',
        body: validGroundtruthBody(),
        headers: { 'x-device-id': deviceId },
      });
      assert.notEqual(r.status, 429, `Call ${i + 1} should not be rate-limited`);
    }
    // 11th should be rate-limited
    const r = await request(port, {
      path: '/api/v1/receipts/groundtruth',
      body: validGroundtruthBody(),
      headers: { 'x-device-id': deviceId },
    });
    assert.equal(r.status, 429);
    assert.ok(r.json && r.json.error === 'rate_limited');
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: multiple validation errors reported together', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, {
      path: '/api/v1/receipts/groundtruth',
      body: { brand: 'UnknownBrand', postcode_outcode: 'B10 0AE', p_per_l: 999, fuel_type: 'hydrogen', receipt_date: '1990-01-01' },
    });
    assert.equal(r.status, 400);
    assert.ok(r.json.errors.length >= 4, `Expected ≥4 errors, got ${r.json.errors.length}`);
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: postcode outcode B10 is accepted', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ postcode_outcode: 'B10' }) });
    assert.equal(r.status, 204);
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

test('POST /receipts/groundtruth: postcode outcode SW1A is accepted', async () => {
  receiptsRouter._resetGtStore();
  const restore = mockGroundtruthRepo();
  const { server, port } = await startApp((app) => { app.use('/api/v1/receipts', receiptsRouter); });
  try {
    const r = await request(port, { path: '/api/v1/receipts/groundtruth', body: validGroundtruthBody({ postcode_outcode: 'SW1A' }) });
    assert.equal(r.status, 204);
  } finally { restore(); await new Promise((res) => server.close(res)); }
});

// ─── OUTCODE_RE regex tests ───────────────────────────────────────────────────
const { OUTCODE_RE } = require('../src/routes/receipts');

test('OUTCODE_RE: accepts valid outcodes', () => {
  const valid = ['B10', 'SW1', 'SW1A', 'EC1A', 'M1', 'W1', 'E1', 'BT1', 'N1', 'SE1'];
  for (const oc of valid) {
    assert.ok(OUTCODE_RE.test(oc), `"${oc}" should be valid outcode`);
  }
});

test('OUTCODE_RE: rejects full postcodes and garbage', () => {
  const invalid = ['B10 0AE', 'SW1A 2AA', '123', 'ABCDE', ''];
  for (const oc of invalid) {
    assert.ok(!OUTCODE_RE.test(oc), `"${oc}" should be rejected by OUTCODE_RE`);
  }
});

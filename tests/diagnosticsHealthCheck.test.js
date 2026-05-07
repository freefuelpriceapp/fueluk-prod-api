'use strict';

/**
 * diagnosticsHealthCheck.test.js — B-06
 *
 * Tests for the diagnostics regional null-rate health-check cron job.
 *
 * Key assertions:
 *  1. noops silently when HEALTHCHECK_WEBHOOK_URL is unset.
 *  2. fires the webhook when a region exceeds 30% null rate.
 *  3. fires the webhook when stale_over_threshold > 5% of total.
 *  4. does NOT fire when everything is healthy.
 *  5. webhook payload contains no price data or PII.
 *  6. continues gracefully when the webhook endpoint returns an error.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ─── Stub out getPool ─────────────────────────────────────────────────────────
const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'config', 'db'));
let poolFactory = null;

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    initPool: async () => {},
    getPool: () => {
      if (!poolFactory) throw new Error('poolFactory not set');
      return poolFactory();
    },
  },
};

const {
  runDiagnosticsHealthCheck,
  computeHealthSnapshot,
  regionFromPostcode,
  NULL_RATE_THRESHOLD_PCT,
  STALE_THRESHOLD_PCT,
} = require('../src/jobs/diagnosticsHealthCheck');

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a fake pool with configurable station rows + stale stats */
function makePool({ stationRows = [], staleRows = [{ total: 100, stale_over_threshold: 3 }] } = {}) {
  return {
    query: async (sql) => {
      // Stale query: SELECT COUNT... FROM stations WHERE last_updated < ...
      if (/stale_over_threshold/i.test(sql)) {
        return { rows: staleRows };
      }
      // Regional null-rate query: SELECT postcode, all_null FROM stations
      return { rows: stationRows };
    },
  };
}

let capturedWebhookPayload = null;
let webhookStatus = 200;
let webhookThrows = false;

const origFetch = global.fetch;

function setupFetch() {
  global.fetch = async (_url, init) => {
    capturedWebhookPayload = JSON.parse(init.body);
    if (webhookThrows) throw new Error('webhook network error');
    return { status: webhookStatus };
  };
}

function teardownFetch() {
  global.fetch = origFetch;
}

function reset() {
  capturedWebhookPayload = null;
  webhookStatus = 200;
  webhookThrows = false;
  delete process.env.HEALTHCHECK_WEBHOOK_URL;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('constants are correct', () => {
  assert.equal(NULL_RATE_THRESHOLD_PCT, 30);
  assert.equal(STALE_THRESHOLD_PCT, 5);
});

test('runDiagnosticsHealthCheck: noops when HEALTHCHECK_WEBHOOK_URL is unset', async () => {
  reset();
  const result = await runDiagnosticsHealthCheck();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'HEALTHCHECK_WEBHOOK_URL not set');
});

test('runDiagnosticsHealthCheck: returns fired=false when all regions are healthy', async () => {
  reset();
  setupFetch();
  process.env.HEALTHCHECK_WEBHOOK_URL = 'https://hooks.example.com/test';

  // 5 stations, all healthy (no nulls), stale < 5%
  const stationRows = [
    { postcode: 'B1 1AA', all_null: false },
    { postcode: 'B1 2BB', all_null: false },
    { postcode: 'B1 3CC', all_null: false },
    { postcode: 'B1 4DD', all_null: false },
    { postcode: 'B1 5EE', all_null: false },
  ];
  // 100 stations, 3 stale (3% < 5%)
  poolFactory = () => makePool({ stationRows, staleRows: [{ total: 100, stale_over_threshold: 3 }] });

  const result = await runDiagnosticsHealthCheck();
  assert.equal(result.fired, false);
  assert.equal(capturedWebhookPayload, null, 'should not have called webhook');
  teardownFetch();
});

test('runDiagnosticsHealthCheck: fires webhook when a region exceeds 30% null', async () => {
  reset();
  setupFetch();
  process.env.HEALTHCHECK_WEBHOOK_URL = 'https://hooks.example.com/test';

  // B11 region: 4/10 = 40% null → breach.
  // Use exact same outcode (same postcode prefix) for all 10 stations so they
  // all bucket into one region and the ≥10 minimum is satisfied.
  const stationRows = [
    ...Array.from({ length: 6 }, () => ({ postcode: 'B11 1AA', all_null: false })),
    ...Array.from({ length: 4 }, () => ({ postcode: 'B11 2BB', all_null: true })),
  ];
  poolFactory = () => makePool({ stationRows, staleRows: [{ total: 100, stale_over_threshold: 3 }] });

  const result = await runDiagnosticsHealthCheck();
  assert.equal(result.fired, true, 'webhook should fire');
  assert.ok(capturedWebhookPayload, 'payload should be set');
  assert.equal(capturedWebhookPayload.service, 'fueluk-api');
  assert.ok(Array.isArray(capturedWebhookPayload.alerts));
  const regionAlert = capturedWebhookPayload.alerts.find(a => a.type === 'regional_null_rate_exceeded');
  assert.ok(regionAlert, 'should have regional_null_rate_exceeded alert');
  assert.ok(regionAlert.null_pct >= 30, 'null_pct should be ≥30');
  teardownFetch();
});

test('runDiagnosticsHealthCheck: fires webhook when stale > 5%', async () => {
  reset();
  setupFetch();
  process.env.HEALTHCHECK_WEBHOOK_URL = 'https://hooks.example.com/test';

  // All healthy regions (no stations → no regions), but 10% stale
  poolFactory = () => makePool({
    stationRows: [],
    staleRows: [{ total: 100, stale_over_threshold: 10 }],
  });

  const result = await runDiagnosticsHealthCheck();
  assert.equal(result.fired, true, 'stale breach should fire webhook');
  const staleAlert = capturedWebhookPayload?.alerts?.find(a => a.type === 'stale_over_threshold_exceeded');
  assert.ok(staleAlert, 'should have stale_over_threshold_exceeded alert');
  assert.ok(staleAlert.stale_pct > 5);
  teardownFetch();
});

test('runDiagnosticsHealthCheck: payload contains no price data or PII', async () => {
  reset();
  setupFetch();
  process.env.HEALTHCHECK_WEBHOOK_URL = 'https://hooks.example.com/test';

  // Use B11 outcode so 10 stations are in one bucket (40% null → breach fires webhook)
  const stationRows = [
    ...Array.from({ length: 6 }, () => ({ postcode: 'B11 1AA', all_null: false })),
    ...Array.from({ length: 4 }, () => ({ postcode: 'B11 2BB', all_null: true })),
  ];
  poolFactory = () => makePool({ stationRows, staleRows: [{ total: 100, stale_over_threshold: 3 }] });

  await runDiagnosticsHealthCheck();
  const payloadStr = JSON.stringify(capturedWebhookPayload);

  // No price values (no pence amounts or device tokens)
  assert.doesNotMatch(payloadStr, /device_token/i);
  assert.doesNotMatch(payloadStr, /push_token/i);
  assert.doesNotMatch(payloadStr, /petrol_price|diesel_price|e10_price/i);
  assert.doesNotMatch(payloadStr, /email|phone|name/i);
  teardownFetch();
});

test('runDiagnosticsHealthCheck: continues gracefully when webhook throws', async () => {
  reset();
  setupFetch();
  webhookThrows = true;
  process.env.HEALTHCHECK_WEBHOOK_URL = 'https://hooks.example.com/test';

  // Use same B11 outcode bucket so >=10 stations land in one region (40% null)
  const stationRows = [
    ...Array.from({ length: 6 }, () => ({ postcode: 'B11 1AA', all_null: false })),
    ...Array.from({ length: 4 }, () => ({ postcode: 'B11 2BB', all_null: true })),
  ];
  poolFactory = () => makePool({ stationRows, staleRows: [{ total: 100, stale_over_threshold: 3 }] });

  // Must not throw
  const result = await runDiagnosticsHealthCheck();
  assert.ok(result.webhook_error, 'should capture webhook error');
  assert.equal(result.fired, true, 'fired flag still set');
  teardownFetch();
});

test('regionFromPostcode: parses standard UK postcodes correctly', () => {
  // The function strips spaces and extracts the leading letters + first digit(s)
  // 'B11 1AA' -> strip -> 'B111AA' -> B + 11 -> 'B11'
  assert.equal(regionFromPostcode('B11 1AA'), 'B11');
  // 'WD25 8JS' -> strip -> 'WD258JS' -> WD + 25 -> 'WD25'
  assert.equal(regionFromPostcode('WD25 8JS'), 'WD25');
  // 'SW1A 1AA' -> strip -> 'SW1A1AA' -> SW + 1A -> 'SW1A'
  assert.equal(regionFromPostcode('SW1A 1AA'), 'SW1A');
  // 'M60 1NW' -> strip -> 'M601NW' -> M + 60 -> 'M60'
  assert.equal(regionFromPostcode('M60 1NW'), 'M60');
  // BT postcodes (Northern Ireland) all bucket to 'BT'
  assert.equal(regionFromPostcode('BT1 1AA'), 'BT');
  assert.equal(regionFromPostcode('BT12 5EE'), 'BT');
  assert.equal(regionFromPostcode(null), null);
  assert.equal(regionFromPostcode(''), null);
});

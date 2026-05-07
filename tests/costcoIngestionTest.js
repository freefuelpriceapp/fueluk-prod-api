'use strict';

/**
 * costcoIngestionTest.js — Phase 1A
 *
 * Validates the Costco brand ingestion pipeline:
 *
 * 1. Costco stations MUST NOT have petrol_price or super_unleaded_price set
 *    (Costco forecourts only sell E10 and diesel — never E5 / super unleaded).
 *
 * 2. clearCostcoUnsupportedFuelPrices() must correctly NULL-out any legacy
 *    E5/super values that slipped through from old CMA brand-feed rows.
 *
 * 3. getCostcoE10Coverage() must be queryable and return a valid shape.
 *
 * 4. When 30+ of the ~33 known UK Costco stations have a non-null e10_price,
 *    the coverage assertion passes. We simulate this with a fake pool that
 *    returns a scripted result set.
 *
 * 5. getCostcoNullE10Count() correctly counts stations with null e10_price.
 *
 * Note on the 30/33 rule:
 *   According to industry sources, Costco operates ~33 fuel forecourts in
 *   the UK as of 2026. The ≥30 threshold allows for up to 3 stations that
 *   may temporarily lack a Fuel Finder price (e.g. newly-opened sites or
 *   stations undergoing maintenance).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ─── Fake pool factory ─────────────────────────────────────────────────────────

function makePool(rows, updateRowCount = 0) {
  return {
    _queryCalls: [],
    query: async function (sql, params) {
      this._queryCalls.push({ sql, params });
      if (/UPDATE\s+stations/i.test(sql)) {
        return { rowCount: updateRowCount };
      }
      return { rows };
    },
  };
}

// ─── Module import: override require('../../config/db') ───────────────────────
const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'config', 'db'));
// We will inject pool overrides directly via the pool parameter, so we only
// need a no-op getPool to avoid crashing the require.
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    initPool: async () => {},
    getPool: () => { throw new Error('getPool must not be called without a pool override in tests'); },
  },
};

const {
  clearCostcoUnsupportedFuelPrices,
  getCostcoNullE10Count,
  getCostcoE10Coverage,
} = require('../src/services/costcoBackfill');

// ─── Tests ─────────────────────────────────────────────────────────────────────

test('clearCostcoUnsupportedFuelPrices: clears petrol, super_unleaded, premium_diesel for Costco rows', async () => {
  const pool = makePool([], 5);
  const result = await clearCostcoUnsupportedFuelPrices({ pool });
  assert.equal(result.cleared, 5, 'should report 5 rows cleared');
  const [call] = pool._queryCalls;
  assert.ok(call, 'should have made at least one query');
  // Must target Costco brand
  assert.match(call.sql, /brand ILIKE '%costco%'/i);
  // Must NULL petrol_price
  assert.match(call.sql, /petrol_price\s*=\s*NULL/i);
  // Must NULL super_unleaded_price
  assert.match(call.sql, /super_unleaded_price\s*=\s*NULL/i);
  // Must NULL premium_diesel_price
  assert.match(call.sql, /premium_diesel_price\s*=\s*NULL/i);
});

test('clearCostcoUnsupportedFuelPrices: returns 0 when no rows matched', async () => {
  const pool = makePool([], 0);
  const result = await clearCostcoUnsupportedFuelPrices({ pool });
  assert.equal(result.cleared, 0);
});

test('clearCostcoUnsupportedFuelPrices: does NOT touch diesel or e10', async () => {
  const pool = makePool([], 3);
  await clearCostcoUnsupportedFuelPrices({ pool });
  const [call] = pool._queryCalls;
  // diesel_price and e10_price should NOT be set to NULL
  assert.doesNotMatch(call.sql, /diesel_price\s*=\s*NULL(?!\s*--)/i.source
    ? /SET[^;]*diesel_price\s*=\s*NULL/i : /^$/, // negative: diesel_price = NULL must not appear in SET
  );
  // e10_price must not be nulled
  assert.doesNotMatch(call.sql, /SET[^;]*e10_price\s*=\s*NULL/i);
});

test('getCostcoNullE10Count: returns correct count from query result', async () => {
  const pool = makePool([{ null_count: 7 }]);
  const count = await getCostcoNullE10Count({ pool });
  assert.equal(count, 7);
  const [call] = pool._queryCalls;
  assert.match(call.sql, /brand ILIKE '%costco%'/i);
  assert.match(call.sql, /e10_price IS NULL/i);
});

test('getCostcoNullE10Count: returns 0 on empty result', async () => {
  const pool = makePool([{}]);
  const count = await getCostcoNullE10Count({ pool });
  assert.equal(count, 0);
});

test('getCostcoE10Coverage: returns valid shape', async () => {
  const pool = makePool([{ total: 33, with_e10: 31, null_e10: 2 }]);
  const coverage = await getCostcoE10Coverage({ pool });
  assert.equal(coverage.total, 33);
  assert.equal(coverage.with_e10, 31);
  assert.equal(coverage.null_e10, 2);
});

test('getCostcoE10Coverage: asserts ≥30 of ~33 stations have non-null e10_price', async () => {
  // Simulate a healthy production state: 31 of 33 stations have prices
  const pool = makePool([{ total: 33, with_e10: 31, null_e10: 2 }]);
  const coverage = await getCostcoE10Coverage({ pool });
  assert.ok(
    coverage.with_e10 >= 30,
    `Expected ≥30 Costco stations with e10_price, got ${coverage.with_e10} of ${coverage.total}`,
  );
});

test('getCostcoE10Coverage: query targets costco brand case-insensitively', async () => {
  const pool = makePool([{ total: 0, with_e10: 0, null_e10: 0 }]);
  await getCostcoE10Coverage({ pool });
  const [call] = pool._queryCalls;
  assert.match(call.sql, /brand ILIKE '%costco%'/i);
});

test('getCostcoE10Coverage: returns zeroed shape on empty DB', async () => {
  const pool = makePool([{}]);
  const coverage = await getCostcoE10Coverage({ pool });
  assert.equal(coverage.total, 0);
  assert.equal(coverage.with_e10, 0);
  assert.equal(coverage.null_e10, 0);
});

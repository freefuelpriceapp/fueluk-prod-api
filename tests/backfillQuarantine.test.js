'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clearMissingFuelTypePrices,
} = require('../src/services/fuelFinder/stationSync');

const {
  clearMissingFuelTypePricesAcrossAll,
} = require('../src/jobs/backfillQuarantine');

function makePool(handlers = []) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      const handler = handlers.shift();
      if (handler) return handler(sql, params);
      return { rowCount: 0, rows: [] };
    },
  };
}

test('clearMissingFuelTypePrices nulls B10 0AE super_unleaded when fuel_types lacks E5', async () => {
  const pool = makePool([
    () => ({ rowCount: 1, rows: [] }), // single UPDATE
  ]);
  const row = {
    fuel_finder_node_id: 'b10-0ae',
    fuel_types: ['E10', 'B7_STANDARD'],
  };
  const rowCount = await clearMissingFuelTypePrices(pool, row);
  assert.equal(rowCount, 1);
  const sql = pool.queries[0].sql;
  // E5 (super_unleaded) and B7_PREMIUM should be in the SET clause.
  assert.match(sql, /super_unleaded_price\s*=\s*NULL/);
  assert.match(sql, /super_unleaded_source\s*=\s*NULL/);
  assert.match(sql, /super_unleaded_updated_at\s*=\s*NULL/);
  assert.match(sql, /premium_diesel_price\s*=\s*NULL/);
  // E10 and B7_STANDARD should NOT be in the SET clause.
  assert.doesNotMatch(sql, /\be10_price\s*=\s*NULL/);
  assert.doesNotMatch(sql, /\bdiesel_price\s*=\s*NULL/);
  // The WHERE clause must protect fuel_finder-sourced fields from clearing.
  assert.match(sql, /COALESCE\(super_unleaded_source, ''\) <> 'fuel_finder'/);
});

test('clearMissingFuelTypePrices is a no-op when station stocks every fuel type', async () => {
  const pool = makePool();
  const row = {
    fuel_finder_node_id: 'all-fuels',
    fuel_types: ['E10', 'E5', 'B7_STANDARD', 'B7_PREMIUM'],
  };
  const rowCount = await clearMissingFuelTypePrices(pool, row);
  assert.equal(rowCount, 0);
  assert.equal(pool.queries.length, 0, 'no UPDATE issued when nothing to clear');
});

test('clearMissingFuelTypePrices skips when fuel_types is empty/null (no authoritative info yet)', async () => {
  const pool = makePool();
  let rc = await clearMissingFuelTypePrices(pool, { fuel_finder_node_id: 'x', fuel_types: null });
  assert.equal(rc, 0);
  rc = await clearMissingFuelTypePrices(pool, { fuel_finder_node_id: 'x', fuel_types: [] });
  assert.equal(rc, 0);
  assert.equal(pool.queries.length, 0);
});

test('clearMissingFuelTypePrices skips when no fuel_finder_node_id', async () => {
  const pool = makePool();
  const rc = await clearMissingFuelTypePrices(pool, { fuel_finder_node_id: null, fuel_types: ['E10'] });
  assert.equal(rc, 0);
  assert.equal(pool.queries.length, 0);
});

test('clearMissingFuelTypePricesAcrossAll iterates fuel_finder-tagged stations only', async () => {
  const stations = [
    { id: 'ff-1', fuel_finder_node_id: 'n1', fuel_types: ['E10', 'B7_STANDARD'] },
    { id: 'ff-2', fuel_finder_node_id: 'n2', fuel_types: ['E10', 'E5', 'B7_STANDARD', 'B7_PREMIUM'] },
  ];
  const pool = makePool([
    () => ({ rowCount: stations.length, rows: stations }), // SELECT
    () => ({ rowCount: 1, rows: [] }), // UPDATE for ff-1
    // ff-2 doesn't get an UPDATE because stocks everything.
  ]);
  const summary = await clearMissingFuelTypePricesAcrossAll(pool);
  assert.equal(summary.stationsTouched, 1);
  assert(summary.fieldsCleared >= 2, 'super_unleaded + premium_diesel cleared');
  // First query is SELECT, second is the UPDATE for ff-1.
  assert.match(pool.queries[0].sql, /SELECT id, fuel_finder_node_id, fuel_types/);
  assert.match(pool.queries[1].sql, /UPDATE stations/);
});

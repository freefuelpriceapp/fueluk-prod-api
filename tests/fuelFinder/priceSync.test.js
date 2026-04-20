'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { syncPrices, applyPriceUpdates } = require('../../src/services/fuelFinder/priceSync');

function makePool(initialState = null) {
  const queries = [];
  let state = initialState;
  return {
    queries,
    getState: () => state,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT last_price_effective_ts')) {
        return { rowCount: state ? 1 : 0, rows: state ? [state] : [] };
      }
      if (sql.startsWith('UPDATE fuel_finder_sync_state')) {
        if (params && params[0]) {
          state = { ...(state || {}), last_price_effective_ts: params[0] };
        }
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith('UPDATE stations')) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

function makeApiClient(batches) {
  const copy = [...batches];
  const calls = [];
  return {
    calls,
    getPricesBatch: async (batchNumber, effectiveStart) => {
      calls.push({ batchNumber, effectiveStart });
      return copy.shift() || [];
    },
  };
}

test('applyPriceUpdates builds single UPDATE with price + source + NOW', async () => {
  const pool = makePool();
  await applyPriceUpdates(pool, 'node1', [
    { priceColumn: 'e10_price', sourceColumn: 'e10_source', price: 129.9, updatedAt: null },
    { priceColumn: 'diesel_price', sourceColumn: 'diesel_source', price: 136.9, updatedAt: null },
  ]);
  const upd = pool.queries.find((q) => q.sql.startsWith('UPDATE stations'));
  assert.ok(upd);
  assert.match(upd.sql, /e10_price = \$2/);
  assert.match(upd.sql, /e10_source = \$3/);
  assert.match(upd.sql, /diesel_price = \$4/);
  assert.match(upd.sql, /diesel_source = \$5/);
  assert.match(upd.sql, /last_updated = NOW\(\)/);
  assert.match(upd.sql, /WHERE fuel_finder_node_id = \$1/);
  assert.deepEqual(upd.params, ['node1', 129.9, 'fuel_finder', 136.9, 'fuel_finder']);
});

test('applyPriceUpdates noop on empty updates', async () => {
  const pool = makePool();
  const n = await applyPriceUpdates(pool, 'x', []);
  assert.equal(n, 0);
  assert.equal(pool.queries.length, 0);
});

test('syncPrices passes stored effective timestamp on subsequent runs', async () => {
  const pool = makePool({ last_price_effective_ts: '2026-04-19T10:00:00.000Z' });
  const apiClient = makeApiClient([[]]);
  await syncPrices({ apiClient, pool });
  assert.equal(apiClient.calls[0].effectiveStart, '2026-04-19T10:00:00.000Z');
});

test('syncPrices omits effective timestamp on first run for a full fetch', async () => {
  const pool = makePool(null);
  const apiClient = makeApiClient([[]]);
  const fakeNow = new Date('2026-04-19T12:00:00Z');
  await syncPrices({ apiClient, pool, now: () => fakeNow });
  assert.equal(apiClient.calls[0].effectiveStart, null);
});

test('syncPrices advances state to the highest price_last_updated seen', async () => {
  const pool = makePool({ last_price_effective_ts: '2026-04-19T10:00:00.000Z' });
  const apiClient = makeApiClient([[
    {
      node_id: 's1',
      fuel_prices: [
        { fuel_type: 'E10', price: 129.9, price_last_updated: '2026-04-19T11:00:00Z' },
        { fuel_type: 'B7_STANDARD', price: 139.9, price_last_updated: '2026-04-19T11:30:00Z' },
      ],
    },
    {
      node_id: 's2',
      fuel_prices: [
        { fuel_type: 'E10', price: 130.9, price_last_updated: '2026-04-19T11:15:00Z' },
      ],
    },
  ]]);
  const result = await syncPrices({ apiClient, pool, delayMs: 0 });
  assert.equal(result.stationsUpdated, 2);
  assert.equal(result.nextEffectiveTs, '2026-04-19T11:30:00.000Z');
  assert.equal(pool.getState().last_price_effective_ts, '2026-04-19T11:30:00.000Z');
});

test('syncPrices tolerates API errors on a batch without losing prior progress', async () => {
  const pool = makePool({ last_price_effective_ts: '2026-04-19T10:00:00.000Z' });
  const bigFirst = Array.from({ length: 500 }, (_, i) => ({
    node_id: `s${i}`,
    fuel_prices: [{ fuel_type: 'E10', price: 130 + i * 0.01, price_last_updated: '2026-04-19T11:00:00Z' }],
  }));
  const api2 = {
    calls: 0,
    getPricesBatch: async (n) => {
      api2.calls++;
      if (n === 1) return bigFirst;
      throw new Error('boom');
    },
  };
  const result = await syncPrices({ apiClient: api2, pool, delayMs: 0 });
  assert.equal(result.errors.length >= 1, true);
  assert.ok(result.stationsUpdated > 0, 'first batch prices still applied');
});

test('syncPrices continues past a single batch failure to later batches', async () => {
  const pool = makePool({ last_price_effective_ts: '2026-04-19T10:00:00.000Z' });
  const bigBatch = (prefix) => Array.from({ length: 500 }, (_, i) => ({
    node_id: `${prefix}${i}`,
    fuel_prices: [{ fuel_type: 'E10', price: 130 + i * 0.01, price_last_updated: '2026-04-19T11:00:00Z' }],
  }));
  const batch1 = bigBatch('a');
  const batch3 = [{
    node_id: 'late',
    fuel_prices: [{ fuel_type: 'E10', price: 145.5, price_last_updated: '2026-04-19T11:45:00Z' }],
  }];
  let n = 0;
  const apiClient = {
    getPricesBatch: async () => {
      n++;
      if (n === 1) return batch1;
      if (n === 2) throw new Error('transient 403');
      if (n === 3) return batch3;
      return [];
    },
  };
  const result = await syncPrices({ apiClient, pool, delayMs: 0 });
  // batch1 had 500 price-updating rows + batch3 had 1 — should total 501
  assert.equal(result.stationsUpdated, 501, 'batch 3 processed despite batch 2 failing');
  assert.equal(result.errors.filter((e) => e.batch === 2).length, 1);
});

test('syncPrices aborts after MAX_CONSECUTIVE_ERRORS consecutive failures', async () => {
  const pool = makePool({ last_price_effective_ts: '2026-04-19T10:00:00.000Z' });
  let calls = 0;
  const apiClient = {
    getPricesBatch: async () => { calls++; throw new Error('boom'); },
  };
  const result = await syncPrices({ apiClient, pool, delayMs: 0 });
  assert.equal(calls, 3, 'should stop after 3 consecutive errors');
  assert.equal(result.errors.length, 3);
});

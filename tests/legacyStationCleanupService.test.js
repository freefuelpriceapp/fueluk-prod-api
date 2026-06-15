'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const SERVICE_PATH = require.resolve(
  '../src/services/legacyStationCleanupService'
);
const DB_PATH = require.resolve('../src/config/db');

/**
 * Build a fake pool whose connect() returns a client we control. The client
 * records every query in `queries` and consults `handlers` (in order) for
 * responses. If `handlers` is exhausted, returns an empty result.
 *
 * Each handler is either a row-shaped object or a function (sql, params)
 * returning one.
 */
function makeFakePool(handlers = []) {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql: sql.trim(), params });
      if (!handlers.length) return { rowCount: 0, rows: [] };
      const next = handlers.shift();
      return typeof next === 'function' ? next(sql, params) : next;
    },
    release: () => {},
  };
  const pool = {
    queries,
    client,
    connect: async () => client,
  };
  return pool;
}

/**
 * Stub the db module so the service-under-test sees our fake pool when it
 * calls getPool(). We reload the service from cache-free state every test so
 * the stub takes effect for the lifetime of that test only.
 */
function withFakePool(pool, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, ...rest) {
    if (parent && parent.filename === SERVICE_PATH && request === '../config/db') {
      return { getPool: () => pool };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  delete require.cache[SERVICE_PATH];
  delete require.cache[DB_PATH];
  try {
    const svc = require('../src/services/legacyStationCleanupService');
    return fn(svc);
  } finally {
    Module._load = originalLoad;
    delete require.cache[SERVICE_PATH];
    delete require.cache[DB_PATH];
  }
}

test('cleanupLegacyStationRows deletes gcqd-* and applegreen_official inside a transaction', async () => {
  const pool = makeFakePool([
    () => ({}),                                                            // BEGIN
    () => ({ rows: [{ total: '11934', gcqd: '3339', applegreen_official: '18' }] }), // before-counts
    () => ({ rows: [{ uf: '4', pa: '2', ph: '5120' }] }),                  // collateral
    () => ({ rowCount: 3339 }),                                            // DELETE gcqd
    () => ({ rowCount: 18 }),                                              // DELETE applegreen_official
    () => ({ rows: [{ total: '8577', gcqd: '0', applegreen_official: '0' }] }), // after-counts
    () => ({}),                                                            // COMMIT
  ]);

  const summary = await withFakePool(pool, (svc) => svc.cleanupLegacyStationRows());

  assert.equal(summary.gcqdRowsDeleted, 3339);
  assert.equal(summary.applegreenOfficialRowsDeleted, 18);
  assert.equal(summary.userFavouritesCollateral, 4);
  assert.equal(summary.priceAlertsCollateral, 2);
  assert.equal(summary.priceHistoryCollateral, 5120);
  assert.equal(summary.before.totalStations, 11934);
  assert.equal(summary.after.totalStations, 8577);
  assert.equal(summary.after.gcqdStations, 0);
  assert.equal(summary.after.applegreenOfficialStations, 0);

  const sqls = pool.queries.map((q) => q.sql);
  assert.equal(sqls[0], 'BEGIN');
  assert.equal(sqls[sqls.length - 1], 'COMMIT');
  assert.match(sqls[3], /DELETE FROM stations\s+WHERE id LIKE 'gcqd%' OR source = 'gov'/);
  assert.match(sqls[4], /DELETE FROM stations\s+WHERE source = 'applegreen_official'/);
});

test('cleanupLegacyStationRows is idempotent: a second run deletes 0 rows and still commits', async () => {
  const pool = makeFakePool([
    () => ({}),
    () => ({ rows: [{ total: '8577', gcqd: '0', applegreen_official: '0' }] }),
    () => ({ rows: [{ uf: '0', pa: '0', ph: '0' }] }),
    () => ({ rowCount: 0 }),
    () => ({ rowCount: 0 }),
    () => ({ rows: [{ total: '8577', gcqd: '0', applegreen_official: '0' }] }),
    () => ({}),
  ]);
  const summary = await withFakePool(pool, (svc) => svc.cleanupLegacyStationRows());
  assert.equal(summary.gcqdRowsDeleted, 0);
  assert.equal(summary.applegreenOfficialRowsDeleted, 0);
  assert.equal(summary.before.totalStations, 8577);
  assert.equal(summary.after.totalStations, 8577);
  assert.equal(pool.queries[pool.queries.length - 1].sql, 'COMMIT');
});

test('cleanupLegacyStationRows rolls back when the post-delete sanity check fails', async () => {
  // Simulate a writer that re-inserted a gcqd row mid-transaction: after
  // counts come back with gcqd=1, which violates the safety check and must
  // trigger a ROLLBACK.
  const pool = makeFakePool([
    () => ({}),
    () => ({ rows: [{ total: '11934', gcqd: '3339', applegreen_official: '18' }] }),
    () => ({ rows: [{ uf: '0', pa: '0', ph: '0' }] }),
    () => ({ rowCount: 3339 }),
    () => ({ rowCount: 18 }),
    () => ({ rows: [{ total: '8578', gcqd: '1', applegreen_official: '0' }] }), // anomaly
    () => ({}), // ROLLBACK
  ]);

  await withFakePool(pool, async (svc) => {
    await assert.rejects(
      () => svc.cleanupLegacyStationRows(),
      /safety check failed/i
    );
  });

  const lastSql = pool.queries[pool.queries.length - 1].sql;
  assert.equal(lastSql, 'ROLLBACK');
});

test('cleanupLegacyStationRows releases the client even when a DELETE throws', async () => {
  let released = false;
  const client = {
    query: async (sql) => {
      if (sql.trim().startsWith('DELETE')) throw new Error('boom');
      if (sql.trim() === 'BEGIN') return {};
      if (sql.trim() === 'ROLLBACK') return {};
      return { rows: [{ total: '0', gcqd: '0', applegreen_official: '0', uf: '0', pa: '0', ph: '0' }] };
    },
    release: () => { released = true; },
  };
  const pool = { connect: async () => client };

  await withFakePool(pool, async (svc) => {
    await assert.rejects(() => svc.cleanupLegacyStationRows(), /boom/);
  });

  assert.equal(released, true, 'client.release() must be called even on failure');
});

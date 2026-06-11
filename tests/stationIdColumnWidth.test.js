'use strict';

/**
 * Sprint 15.1 regression — VARCHAR widths on every station_id foreign key.
 *
 * Bug: priceSync.js was spamming CloudWatch every 5 minutes with
 *   `[FuelFinder] price_history insert failed for ff-<64hex>/diesel:
 *    value too long for type character varying(50)`
 * because `stations.id` had been widened to VARCHAR(100) for Fuel Finder
 * IDs (3-char prefix + 64-char node_id = 67 chars), but the FK columns
 * referencing it (price_history, price_alerts, user_favourites,
 * price_reports, non_gov_prices, price_flags, price_flag_quarantine)
 * were still VARCHAR(50). Postgres rejected the insert with code 22001.
 *
 * Two layers of guard here:
 *   1. Static check that schema.sql + migrate.js declare every station_id
 *      FK column at VARCHAR(100). A regression of either file fails fast.
 *   2. Functional check that applyPriceUpdates passes a 67-char station id
 *      through to the history insert exactly (no truncation in app code).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FUEL_FINDER_ID = 'ff-9f70c560f658b4dfa2e1e4e4da884c9634f9fcfbbb89168033ed5b24895ab702';

test('Fuel Finder station id is the realistic 67-char shape', () => {
  // Guards against the fixture being shortened by accident in a future edit.
  assert.equal(FUEL_FINDER_ID.length, 67);
  assert.ok(FUEL_FINDER_ID.startsWith('ff-'));
});

test('schema.sql declares stations.id at VARCHAR(100) or wider', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'schema.sql'),
    'utf8'
  );
  // stations.id PK
  const stationsId = schema.match(/CREATE TABLE IF NOT EXISTS stations[\s\S]*?id\s+VARCHAR\((\d+)\)\s+PRIMARY KEY/i);
  assert.ok(stationsId, 'could not find stations.id PK in schema.sql');
  assert.ok(
    Number(stationsId[1]) >= 100,
    `stations.id is VARCHAR(${stationsId[1]}); needs >=100 for Fuel Finder IDs`
  );
});

test('schema.sql declares every station_id FK at VARCHAR(100) or wider', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '..', 'schema.sql'),
    'utf8'
  );
  // Match every column declared as `station_id ... VARCHAR(N) ... REFERENCES stations(id)`.
  const fkRe = /station_id\s+VARCHAR\((\d+)\)[^,]*REFERENCES\s+stations\(id\)/gi;
  const widths = [];
  let m;
  while ((m = fkRe.exec(schema)) !== null) {
    widths.push(Number(m[1]));
  }
  assert.ok(widths.length > 0, 'no station_id FK columns found in schema.sql');
  for (const w of widths) {
    assert.ok(w >= 100, `found station_id FK declared as VARCHAR(${w}); needs >=100`);
  }
});

test('migrate.js widens every station_id FK to VARCHAR(100) on boot', () => {
  const migrate = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'config', 'migrate.js'),
    'utf8'
  );
  // Every FK table that holds station_id must be widened by an ALTER COLUMN.
  const required = [
    'price_history',
    'price_alerts',
    'user_favourites',
    'price_reports',
    'non_gov_prices',
    'price_flags',
    'price_flag_quarantine',
  ];
  for (const table of required) {
    const re = new RegExp(
      `ALTER\\s+TABLE\\s+${table}\\s+ALTER\\s+COLUMN\\s+station_id\\s+TYPE\\s+VARCHAR\\(100\\)`,
      'i'
    );
    assert.ok(
      re.test(migrate),
      `migrate.js missing ALTER COLUMN to VARCHAR(100) for ${table}.station_id`
    );
  }
});

test('applyPriceUpdates passes the full 67-char station id to the history insert (no app-level truncation)', async () => {
  // Tear down the cached pg pool from any earlier test run so the require
  // graph picks up our stubbed pool below cleanly.
  const dbPath = require.resolve('../src/config/db');
  delete require.cache[dbPath];

  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      // Mimic the two distinct shapes the function expects:
      //   1) SELECT current prices/id — return one row with our long id.
      //   2) UPDATE stations         — return rowCount=1 so the history
      //                                insert branch fires.
      //   3) INSERT INTO price_history — return rowCount=1.
      if (/^SELECT/i.test(sql)) {
        return { rows: [{ id: FUEL_FINDER_ID, e10_price: 130.0 }], rowCount: 1 };
      }
      if (/^UPDATE\s+stations/i.test(sql)) {
        return { rowCount: 1 };
      }
      if (/INSERT\s+INTO\s+price_history/i.test(sql)) {
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const { applyPriceUpdates } = require('../src/services/fuelFinder/priceSync');
  await applyPriceUpdates(pool, 'node-xyz', [
    { priceColumn: 'e10_price', sourceColumn: 'e10_source', price: 145.9, updatedAt: '2026-06-11T20:15:00Z' },
  ]);

  const historyInsert = queries.find((q) => /INSERT\s+INTO\s+price_history/i.test(q.sql));
  assert.ok(historyInsert, 'expected a price_history insert when price changed');
  // First param is the station id; must round-trip in full, no truncation.
  assert.equal(historyInsert.params[0], FUEL_FINDER_ID);
  assert.equal(historyInsert.params[0].length, 67);
});

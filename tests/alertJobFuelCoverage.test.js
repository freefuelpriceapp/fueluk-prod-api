'use strict';
/**
 * Wave B (B-04) — alertJob full fuel taxonomy coverage.
 *
 * The alert evaluator must:
 *   1. Fire for all 4 modern taxonomy keys (unleaded, super_unleaded, diesel,
 *      premium_diesel) when a station's resolved price is at/below threshold.
 *   2. Translate legacy fuel_type values ('petrol', 'e10' → 'unleaded';
 *      'e5' → 'super_unleaded') so historical alert rows keep firing.
 *   3. NOT fire when the underlying price is NULL (per-field quarantine
 *      from Wave A.1 nullifies the column).
 *   4. Resolve 'unleaded' to the cheaper of e10_price / petrol_price (Wave A.2).
 *
 * The job is exercised by a fake pg pool that records the SQL it sees and
 * returns scripted rows. We assert on the SQL shape and the resulting Expo
 * push payload.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub pg pool BEFORE requiring alertJob.
const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'config', 'db'));
let lastSelectSql = null;
let selectRows = [];
let updatedIds = null;

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    initPool: async () => {},
    getPool: () => ({
      query: async (sql, params) => {
        if (/^\s*UPDATE price_alerts/i.test(sql)) {
          updatedIds = params && params[0];
          return { rowCount: (params && params[0] && params[0].length) || 0 };
        }
        // Otherwise it's the big triggered-alerts SELECT.
        lastSelectSql = sql;
        return { rows: selectRows };
      },
    }),
  },
};

// Stub feature flags so price_alerts is enabled.
const flagsPath = require.resolve(
  path.join(__dirname, '..', 'src', 'utils', 'featureFlags'),
);
require.cache[flagsPath] = {
  id: flagsPath,
  filename: flagsPath,
  loaded: true,
  exports: { isEnabled: () => true },
};

// Stub global fetch so the job can "send" Expo pushes without network.
let pushPayloads = null;
global.fetch = async (_url, init) => {
  pushPayloads = JSON.parse(init.body);
  return {
    json: async () => ({ data: [] }),
  };
};

const { runAlertCheck } = require('../src/jobs/alertJob');

function reset() {
  lastSelectSql = null;
  selectRows = [];
  updatedIds = null;
  pushPayloads = null;
}

test('alertJob query covers all four modern taxonomy keys', async () => {
  reset();
  await runAlertCheck();
  const sql = lastSelectSql || '';
  assert.match(sql, /'unleaded'/);
  assert.match(sql, /'super_unleaded'/);
  assert.match(sql, /'diesel'/);
  assert.match(sql, /'premium_diesel'/);
  // Resolved unleaded uses LEAST over e10_price + petrol_price (Wave A.2 cheaper-of).
  assert.match(sql, /LEAST\s*\(/i);
  assert.match(sql, /e10_price/);
  assert.match(sql, /petrol_price/);
  assert.match(sql, /super_unleaded_price/);
  assert.match(sql, /premium_diesel_price/);
});

test('alertJob query translates legacy fuel_type values (petrol, e10, e5)', async () => {
  reset();
  await runAlertCheck();
  const sql = lastSelectSql || '';
  // Legacy → modern translation happens in a CTE before the join.
  assert.match(sql, /WHEN 'petrol' THEN 'unleaded'/);
  assert.match(sql, /WHEN 'e10'\s+THEN 'unleaded'/);
  assert.match(sql, /WHEN 'e5'\s+THEN 'super_unleaded'/);
});

test('alertJob fires for all 4 modern taxonomy keys', async () => {
  reset();
  selectRows = [
    {
      id: 1, device_token: 'ExponentPushToken[a]', platform: 'ios',
      fuel_type: 'unleaded', original_fuel_type: 'unleaded',
      threshold_pence: 150, station_name: 'A', station_brand: 'BRAND_A',
      current_price: 148.5,
    },
    {
      id: 2, device_token: 'ExponentPushToken[b]', platform: 'ios',
      fuel_type: 'super_unleaded', original_fuel_type: 'super_unleaded',
      threshold_pence: 170, station_name: 'B', station_brand: 'BRAND_B',
      current_price: 165.0,
    },
    {
      id: 3, device_token: 'ExponentPushToken[c]', platform: 'android',
      fuel_type: 'diesel', original_fuel_type: 'diesel',
      threshold_pence: 160, station_name: 'C', station_brand: 'BRAND_C',
      current_price: 155.2,
    },
    {
      id: 4, device_token: 'ExponentPushToken[d]', platform: 'android',
      fuel_type: 'premium_diesel', original_fuel_type: 'premium_diesel',
      threshold_pence: 180, station_name: 'D', station_brand: 'BRAND_D',
      current_price: 175.0,
    },
  ];

  const result = await runAlertCheck();
  assert.equal(result.fired, 4);
  assert.equal(pushPayloads.length, 4);
  const fuelTypesNotified = pushPayloads.map(p => p.data.fuelType).sort();
  assert.deepEqual(fuelTypesNotified, [
    'diesel', 'premium_diesel', 'super_unleaded', 'unleaded',
  ]);
  assert.deepEqual(updatedIds.sort(), [1, 2, 3, 4]);
});

test('alertJob does NOT fire when underlying price is quarantined (NULL)', async () => {
  reset();
  // The DB-level filter ensures NULL prices never appear in the result set.
  // This test models that contract: if the pool returns no rows (because the
  // SQL filter excluded a quarantined station), the job reports zero fires.
  selectRows = [];

  const result = await runAlertCheck();
  assert.equal(result.fired, 0);
  assert.equal(updatedIds, null, 'must not run UPDATE when nothing fired');
  assert.equal(pushPayloads, null, 'must not call Expo when nothing fired');

  // And confirm the SQL itself excludes NULL prices for every fuel branch.
  const sql = lastSelectSql || '';
  assert.match(sql, /super_unleaded_price IS NOT NULL/);
  assert.match(sql, /diesel_price IS NOT NULL/);
  assert.match(sql, /premium_diesel_price IS NOT NULL/);
  // For unleaded, both source columns must be checked.
  assert.match(sql, /e10_price IS NOT NULL OR s\.petrol_price IS NOT NULL/);
});

test('alertJob notification labels render the modern taxonomy nicely', async () => {
  reset();
  selectRows = [
    {
      id: 5, device_token: 'ExponentPushToken[e]', platform: 'ios',
      fuel_type: 'super_unleaded', original_fuel_type: 'e5',
      threshold_pence: 170, station_name: 'E', station_brand: 'BRAND_E',
      current_price: 165.0,
    },
    {
      id: 6, device_token: 'ExponentPushToken[f]', platform: 'ios',
      fuel_type: 'premium_diesel', original_fuel_type: 'premium_diesel',
      threshold_pence: 180, station_name: 'F', station_brand: 'BRAND_F',
      current_price: 175.0,
    },
  ];

  await runAlertCheck();
  const titles = pushPayloads.map(p => p.title).sort();
  assert.deepEqual(titles, [
    'Premium diesel price alert',
    'Super unleaded price alert',
  ]);
});

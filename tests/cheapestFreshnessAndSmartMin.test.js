'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Wave A.10 regression tests for the cheapest-unleaded ranking bug.
 *
 * Two bugs being locked down:
 *   1. The "petrol" cheapest sort historically ordered by petrol_price only.
 *      Supermarkets (Asda/Tesco/Sainsbury's/Morrisons) fill e10_price and
 *      leave petrol_price NULL, so they were excluded from cheapest-unleaded
 *      rankings. Fix: rank by LEAST(petrol_price, e10_price).
 *
 *   2. The Applegreen non-gov feed stopped refreshing on 2026-05-07, leaving
 *      stale ~135p prices that outranked fresh ~155p supermarkets. Fix:
 *      freshness gate \u2014 prices older than CHEAPEST_FRESHNESS_DAYS fall to
 *      NULLS LAST so stale rows can't claim "cheapest".
 *
 * We intercept the pg pool to capture the actual SQL the repository emits and
 * assert on its shape. This is a unit-level guard that won't drift with infra.
 */

// --- Pool stub --------------------------------------------------------------
const capturedQueries = [];
const dbModulePath = require.resolve('../src/config/db');
require('module')._cache[dbModulePath] = {
  exports: {
    getPool: () => ({
      query: async (text, params) => {
        capturedQueries.push({ text, params });
        return { rows: [] };
      },
    }),
  },
};

const repo = require('../src/repositories/stationRepository');

function lastQuery() {
  return capturedQueries[capturedQueries.length - 1].text;
}

// --- Tests ------------------------------------------------------------------

test('cheapest unleaded ordering uses LEAST(petrol_price, e10_price)', async () => {
  capturedQueries.length = 0;
  await repo.getNearbyStations({
    lat: 52.4862, lng: -1.8904, radiusKm: 16, fuel: 'petrol',
    orderBy: 'price', limit: 20,
  });
  const sql = lastQuery();
  assert.match(sql, /LEAST\(NULLIF\(petrol_price, 0\), NULLIF\(e10_price, 0\)\)/,
    'expected LEAST(...) of petrol_price and e10_price in ORDER BY');
});

test('cheapest unleaded ordering enforces freshness gate', async () => {
  capturedQueries.length = 0;
  await repo.getNearbyStations({
    lat: 52.4862, lng: -1.8904, radiusKm: 16, fuel: 'petrol',
    orderBy: 'price', limit: 20,
  });
  const sql = lastQuery();
  assert.match(sql, /GREATEST\(petrol_updated_at, e10_updated_at\)/,
    'expected per-fuel updated_at columns in freshness gate');
  assert.match(sql, /NOW\(\) - INTERVAL '7 days'/,
    'expected 7-day freshness window in ORDER BY CASE');
  assert.match(sql, /NULLS LAST/, 'stale rows must sort last');
});

test('cheapest diesel ordering uses diesel_price + diesel_updated_at', async () => {
  capturedQueries.length = 0;
  await repo.getNearbyStations({
    lat: 52.4862, lng: -1.8904, radiusKm: 16, fuel: 'diesel',
    orderBy: 'price', limit: 20,
  });
  const sql = lastQuery();
  // Diesel column is unambiguous \u2014 must NOT use LEAST/e10
  assert.doesNotMatch(sql, /LEAST\(/, 'diesel sort should not use LEAST');
  assert.match(sql, /diesel_updated_at/, 'diesel freshness gate must use diesel_updated_at');
});

test('cheapest e10 ordering uses e10_price + e10_updated_at', async () => {
  capturedQueries.length = 0;
  await repo.getNearbyStations({
    lat: 52.4862, lng: -1.8904, radiusKm: 16, fuel: 'e10',
    orderBy: 'price', limit: 20,
  });
  const sql = lastQuery();
  assert.doesNotMatch(sql, /LEAST\(/, 'e10 sort should not use LEAST');
  assert.match(sql, /e10_updated_at/, 'e10 freshness gate must use e10_updated_at');
});

test('distance ordering is NOT freshness-gated (closest-first still wins)', async () => {
  capturedQueries.length = 0;
  await repo.getNearbyStations({
    lat: 52.4862, lng: -1.8904, radiusKm: 16, fuel: 'petrol',
    orderBy: 'distance', limit: 20,
  });
  const sql = lastQuery();
  // The CASE expression for freshness lives inside the price branch \u2014
  // for distance-ordering we expect the simple distance_m sort first.
  assert.match(sql, /ORDER BY distance_m ASC/);
});

// --- nonGovFuelData refresh policy -----------------------------------------

test('AUTHORITATIVE_SOURCES exports applegreen_official for refresh', () => {
  const { AUTHORITATIVE_SOURCES } = require('../src/services/nonGovFuelData');
  assert.ok(AUTHORITATIVE_SOURCES instanceof Set, 'AUTHORITATIVE_SOURCES must be a Set');
  assert.ok(AUTHORITATIVE_SOURCES.has('applegreen_official'),
    'applegreen_official must be authoritative so its prices self-refresh');
});

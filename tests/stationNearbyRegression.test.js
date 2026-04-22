'use strict';

/**
 * Regression coverage for the "Small Heath vs Holyhead Road" bug:
 *   - /stations/nearby was silently dropping a closer+cheaper Applegreen in
 *     favour of a farther+pricier one because the repo query ordered by
 *     petrol_price with LIMIT 50, which could push the nearer station out of
 *     the response entirely.
 *   - /stations/nearby must now return every station the repo returns (no
 *     client-side trim), ranked by distance ascending.
 *   - Both /nearby and /cheapest must expose a best_option field with a
 *     selected_reason so the mobile "Best Option" card can render a truthful
 *     explanation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub DB config before anything else requires the service/repo.
require('module')._cache[require.resolve('../src/config/db')] = {
  exports: { getPool: () => ({ query: async () => ({ rows: [] }) }) },
};

const repoPath = require.resolve('../src/repositories/stationRepository');
const repoCalls = { getNearbyStations: [] };
let repoRows = [];
const fakeRepo = {
  async getNearbyStations(args) {
    repoCalls.getNearbyStations.push(args);
    return repoRows;
  },
  async getDistinctBrands() { return []; },
  async searchStations() { return []; },
  async searchStationsTokens() { return []; },
  async searchStationsSmart() { return []; },
  async getStationById() { return null; },
};
require('module')._cache[repoPath] = { exports: fakeRepo };

const stationController = require('../src/controllers/stationController');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function applegreen(overrides = {}) {
  return {
    id: 'gcqxsmallheath',
    name: 'Applegreen Small Heath Highway',
    brand: 'Applegreen',
    address: 'Small Heath Highway',
    postcode: 'B10 0AE',
    lat: 52.472,
    lng: -1.872,
    petrol_price: 140.0,
    diesel_price: 148.9,
    e10_price: 138.9,
    super_unleaded_price: null,
    premium_diesel_price: null,
    petrol_source: 'applegreen_official',
    diesel_source: 'applegreen_official',
    e10_source: 'applegreen_official',
    super_unleaded_source: null,
    premium_diesel_source: null,
    last_updated: '2026-04-22T02:00:00Z',
    opening_hours: null,
    amenities: [],
    is_motorway: false,
    is_supermarket: false,
    temporary_closure: false,
    permanent_closure: false,
    fuel_types: [],
    distance_m: 708, // ~0.44 mi
    ...overrides,
  };
}

function applegreenHolyhead(overrides = {}) {
  return applegreen({
    id: 'gcqxholyhead',
    name: 'Applegreen Holyhead Road',
    address: '122 Holyhead Road, Birmingham',
    postcode: 'B21 0AA',
    lat: 52.508,
    lng: -1.925,
    petrol_price: 151.8,
    diesel_price: 159.9,
    e10_price: 149.9,
    petrol_source: 'gov',
    diesel_source: 'gov',
    e10_source: 'gov',
    last_updated: '2026-04-22T02:00:00Z',
    distance_m: 7289, // ~4.53 mi
    ...overrides,
  });
}

test('[regression] /nearby returns BOTH Applegreens when the DB returns both', async () => {
  repoRows = [applegreen(), applegreenHolyhead()];
  repoCalls.getNearbyStations.length = 0;
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.equal(res.statusCode, 200);
  const names = res.body.stations.map(s => s.name);
  assert.ok(names.some(n => /Small Heath/i.test(n)),
    `Small Heath must be in /nearby response (got: ${names.join(' | ')})`);
  assert.ok(names.some(n => /Holyhead/i.test(n)),
    `Holyhead must be in /nearby response (got: ${names.join(' | ')})`);
  assert.equal(res.body.stations.length, 2);
});

test('[regression] /nearby requests distance-ordered rows from the repo', async () => {
  repoRows = [applegreen(), applegreenHolyhead()];
  repoCalls.getNearbyStations.length = 0;
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.equal(repoCalls.getNearbyStations.length, 1);
  assert.equal(repoCalls.getNearbyStations[0].orderBy, 'distance',
    '/nearby must tell the repo to order by distance, not price');
});

test('[regression] /cheapest still requests price-ordered rows from the repo', async () => {
  repoRows = [applegreen(), applegreenHolyhead()];
  repoCalls.getNearbyStations.length = 0;
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', fuel_type: 'petrol' } };
  const res = mockRes();
  await stationController.getCheapest(req, res, (e) => { throw e; });
  assert.equal(repoCalls.getNearbyStations.length, 1);
  assert.equal(repoCalls.getNearbyStations[0].orderBy, 'price',
    '/cheapest must tell the repo to order by price');
});

test('[regression] /nearby best_option picks the closer+cheaper station and explains why', async () => {
  repoRows = [applegreen(), applegreenHolyhead()];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', fuel_type: 'petrol' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  const best = res.body.best_option;
  assert.ok(best, 'best_option must be populated');
  assert.match(best.name, /Small Heath/i);
  assert.equal(best.petrol_price, 140.0);
  assert.equal(best.is_best_option, true);
  assert.ok(best.selected_reason);
  assert.match(best.selected_reason, /cheapest/i);
});

test('[regression] /nearby exposes top-level selected_reason mirroring best_option.selected_reason', async () => {
  repoRows = [applegreen(), applegreenHolyhead()];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.ok(res.body.selected_reason, 'top-level selected_reason must be non-null when best_option is set');
  assert.match(res.body.selected_reason, /cheapest/i);
  assert.equal(res.body.selected_reason, res.body.best_option.selected_reason,
    'top-level selected_reason must match best_option.selected_reason');
});

test('[regression] /nearby top-level selected_reason defaults to petrol when fuel_type omitted', async () => {
  repoRows = [applegreen(), applegreenHolyhead()];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.match(res.body.selected_reason, /petrol/i);
});

test('[regression] /cheapest also exposes top-level selected_reason', async () => {
  repoRows = [applegreen(), applegreenHolyhead()];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', fuel_type: 'petrol' } };
  const res = mockRes();
  await stationController.getCheapest(req, res, (e) => { throw e; });
  assert.ok(res.body.selected_reason);
  assert.match(res.body.selected_reason, /cheapest/i);
});

test('[regression] /nearby best_option falls back when only one station has a price', async () => {
  repoRows = [applegreen({ petrol_price: null, petrol_source: null }), applegreenHolyhead()];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', fuel_type: 'petrol' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  const best = res.body.best_option;
  assert.ok(best);
  assert.match(best.name, /Holyhead/i,
    'best_option should be the only station with a fresh petrol price');
});

test('[regression] /nearby best_option is null when every station has no fresh price', async () => {
  repoRows = [
    applegreen({ petrol_price: null, petrol_source: null }),
    applegreenHolyhead({ petrol_price: null, petrol_source: null }),
  ];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', fuel_type: 'petrol' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.equal(res.body.best_option, null);
});

test('[regression] /cheapest best_option matches stations[0] (cheapest first)', async () => {
  // Repo returns rows price-ordered (Small Heath first by price).
  repoRows = [applegreen(), applegreenHolyhead()];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', fuel: 'petrol' } };
  const res = mockRes();
  await stationController.getCheapest(req, res, (e) => { throw e; });
  assert.equal(res.body.stations[0].name, res.body.best_option.name,
    'first station in /cheapest should be the best option');
  assert.match(res.body.best_option.selected_reason, /cheapest/i);
});

test('[regression] /nearby skips stale stations when choosing best_option', async () => {
  // Small Heath is stale (>48h old), Holyhead is fresh. Best option must be Holyhead.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  repoRows = [
    applegreen({ last_updated: sevenDaysAgo }),
    applegreenHolyhead(),
  ];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', fuel_type: 'petrol' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  const best = res.body.best_option;
  assert.ok(best);
  assert.match(best.name, /Holyhead/i,
    'stale Small Heath must not be picked as best option');
});

test('[regression] selectBestOptionIndex (unit): cheaper wins; ties broken by distance', () => {
  const { selectBestOptionIndex } = require('../src/utils/stationQuarantine');
  const stations = [
    { id: 'a', petrol_price: 150, distance_miles: 1.0, stale: false },
    { id: 'b', petrol_price: 140, distance_miles: 5.0, stale: false },
    { id: 'c', petrol_price: 140, distance_miles: 0.5, stale: false },
  ];
  const res = selectBestOptionIndex(stations, 'petrol', { radiusMiles: 5 });
  assert.equal(res.index, 2, 'tie between b and c must be broken by closer distance (c)');
  assert.match(res.reason, /Cheapest petrol within 5 mi/);
});

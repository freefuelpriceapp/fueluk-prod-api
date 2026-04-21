'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub DB config so requiring the service doesn't open a pool.
require('module')._cache[require.resolve('../src/config/db')] = {
  exports: { getPool: () => ({ query: async () => ({ rows: [] }) }) },
};

// Stub the repository with fixture rows in the raw DB shape (lat, lng,
// distance_m) so we can assert how the service transforms them.
const repoPath = require.resolve('../src/repositories/stationRepository');
const fakeRepo = {
  __rows: [],
  setRows(rows) { this.__rows = rows; },
  async getNearbyStations() { return this.__rows; },
  async searchStations() { return this.__rows; },
  async searchStationsTokens() { return this.__rows; },
  async searchStationsSmart() { return this.__rows; },
  async getStationById() { return this.__rows[0] || null; },
  async getDistinctBrands() { return []; },
};
require('module')._cache[repoPath] = { exports: fakeRepo };

const stationService = require('../src/services/stationService');

function row(overrides = {}) {
  return {
    id: 'abc123',
    brand: 'ESSO',
    name: 'MFG Expressway Lichfield Road',
    address: 'Lichfield Road, Aston',
    postcode: 'B6 5SU',
    lat: '52.504',
    lng: '-1.877',
    petrol_price: 142.9,
    diesel_price: 149.9,
    e10_price: 141.9,
    super_unleaded_price: null,
    premium_diesel_price: null,
    petrol_source: 'gov',
    diesel_source: 'gov',
    e10_source: 'gov',
    super_unleaded_source: null,
    premium_diesel_source: null,
    last_updated: '2026-04-20T08:00:00Z',
    opening_hours: null,
    amenities: [],
    is_motorway: false,
    is_supermarket: false,
    temporary_closure: false,
    permanent_closure: false,
    fuel_types: [],
    distance_m: 2414,
    ...overrides,
  };
}

test('getNearbyStations returns latitude and longitude populated from DB lat/lng', async () => {
  fakeRepo.setRows([row()]);
  const out = await stationService.getNearbyStations({ lat: 52.4665, lon: -1.8742, radius: 5 });
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(typeof s.latitude, 'number', 'latitude must be a number');
  assert.equal(typeof s.longitude, 'number', 'longitude must be a number');
  assert.ok(Number.isFinite(s.latitude));
  assert.ok(Number.isFinite(s.longitude));
  assert.equal(s.latitude, 52.504);
  assert.equal(s.longitude, -1.877);
  // Legacy fields retained.
  assert.equal(s.lat, 52.504);
  assert.equal(s.lon, -1.877);
});

test('getNearbyStations normalises "Motor Fuel Group" brand to "Esso"', async () => {
  fakeRepo.setRows([row({ brand: 'Motor Fuel Group' })]);
  const out = await stationService.getNearbyStations({ lat: 52.4665, lon: -1.8742, radius: 5 });
  assert.equal(out[0].brand, 'Esso');
});

test('getNearbyStations title-cases SHOUTING brand "ESSO" -> "Esso"', async () => {
  fakeRepo.setRows([row({ brand: 'ESSO' })]);
  const out = await stationService.getNearbyStations({ lat: 52.4665, lon: -1.8742, radius: 5 });
  assert.equal(out[0].brand, 'Esso');
});

test('getNearbyStations converts distance_m to distance_miles', async () => {
  fakeRepo.setRows([row({ distance_m: 3218.68 })]); // ~2 miles
  const out = await stationService.getNearbyStations({ lat: 52.4665, lon: -1.8742, radius: 5 });
  assert.ok(typeof out[0].distance_miles === 'number');
  assert.ok(Math.abs(out[0].distance_miles - 2.0) < 0.05, `expected ~2, got ${out[0].distance_miles}`);
});

test('getStationById carries latitude/longitude through', async () => {
  fakeRepo.setRows([row()]);
  const s = await stationService.getStationById('abc123');
  assert.equal(s.latitude, 52.504);
  assert.equal(s.longitude, -1.877);
});

test('formatted station keeps MFG Expressway name intact after brand remap', async () => {
  fakeRepo.setRows([row({ brand: 'Motor Fuel Group', name: 'MFG Expressway Lichfield Road' })]);
  const out = await stationService.getNearbyStations({ lat: 52.4665, lon: -1.8742, radius: 5 });
  assert.equal(out[0].brand, 'Esso');
  assert.equal(out[0].name, 'MFG Expressway Lichfield Road');
});

test('nullable lat/lng rows produce null latitude/longitude without crashing', async () => {
  fakeRepo.setRows([row({ lat: null, lng: null, distance_m: null })]);
  const out = await stationService.getNearbyStations({ lat: 52.4665, lon: -1.8742, radius: 5 });
  assert.equal(out[0].latitude, null);
  assert.equal(out[0].longitude, null);
  assert.equal(out[0].distance_miles, null);
});

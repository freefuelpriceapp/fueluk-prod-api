'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the DB module before anything imports it.
require('module')._cache[require.resolve('../src/config/db')] = {
  exports: { getPool: () => ({ query: async () => ({ rows: [] }) }) },
};

// Stub stationService — the controller just calls into it.
const servicePath = require.resolve('../src/services/stationService');
const serviceState = { nearbyRows: [], cheapestRows: [] };
const fakeService = {
  async getNearbyStations() { return serviceState.nearbyRows; },
  async getCheapestNearby() { return serviceState.cheapestRows; },
  async searchStations() { return []; },
  async getStationById() { return null; },
  async getDistinctBrands() { return []; },
};
require('module')._cache[servicePath] = { exports: fakeService };

// Stub trajectoryService so we don't rely on its real DB calls.
const trajPath = require.resolve('../src/services/trajectoryService');
const fakeTrajectory = {
  async annotateTrajectory(stations, { fuelType }) {
    const national = {
      direction: 'rising',
      delta_7d_p: 1.8,
      confidence: 'low',
      source: 'national',
      recommendation: 'Fill today — prices rising',
      fuel_type: String(fuelType || 'E10').toUpperCase(),
    };
    const perStation = stations.map((s) => ({
      direction: 'rising',
      delta_7d_p: 2.4,
      confidence: 'high',
      source: 'station',
      recommendation: 'Fill today — prices rising',
      fuel_type: String(fuelType || 'E10').toUpperCase(),
    }));
    return { perStation, national };
  },
};
require('module')._cache[trajPath] = { exports: fakeTrajectory };

// Stub communityQuarantineService — no DB in unit runs.
const cqPath = require.resolve('../src/services/communityQuarantineService');
const fakeCq = {
  async applyCommunityQuarantine(stations) { return stations; },
};
require('module')._cache[cqPath] = { exports: fakeCq };

const stationController = require('../src/controllers/stationController');
const priceFlagsController = require('../src/controllers/priceFlagsController');

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function station(overrides = {}) {
  return {
    id: 's1',
    name: 'Test Forecourt',
    brand: 'Shell',
    distance_miles: 1.2,
    e10_price: 155.9,
    petrol_price: 158.9,
    diesel_price: 162.9,
    last_updated: new Date().toISOString(),
    ...overrides,
  };
}

test('getNearby: populates break_even, trajectory, best_value, national_trajectory', async () => {
  serviceState.nearbyRows = [
    station({ id: 'near', distance_miles: 0.5, e10_price: 165 }),
    station({ id: 'far',  distance_miles: 3.0, e10_price: 150 }),
  ];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', mpg: '45', fuel_type: 'E10' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });

  assert.equal(res.statusCode, 200);
  const { body } = res;
  assert.equal(body.success, true);
  assert.equal(body.stations.length, 2);

  // break_even populated on each station.
  for (const s of body.stations) {
    assert.ok(s.break_even, 'break_even block must be present');
    assert.equal(typeof s.break_even.fuel_cost_full_tank, 'number');
    assert.equal(typeof s.break_even.net_cost, 'number');
    assert.equal(s.break_even.mpg_used, 45);
    assert.equal(s.break_even.mpg_source, 'user');
  }

  // best_value picks the far station with positive savings.
  assert.ok(body.best_value);
  assert.equal(body.best_value.id, 'far');
  assert.match(body.best_value_reason, /Saves £/);

  // trajectory per station + national block.
  for (const s of body.stations) {
    assert.ok(s.trajectory);
    assert.equal(s.trajectory.direction, 'rising');
    assert.equal(s.trajectory.source, 'station');
  }
  assert.ok(body.national_trajectory);
  assert.equal(body.national_trajectory.source, 'national');
});

test('getNearby: break_even omitted when ENABLE_BREAK_EVEN=false', async () => {
  serviceState.nearbyRows = [station()];
  process.env.ENABLE_BREAK_EVEN = 'false';
  try {
    const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5' } };
    const res = mockRes();
    await stationController.getNearby(req, res, (e) => { throw e; });
    assert.equal(res.body.stations[0].break_even, undefined);
    assert.equal(res.body.best_value, null);
  } finally {
    delete process.env.ENABLE_BREAK_EVEN;
  }
});

test('getNearby: trajectory omitted when ENABLE_TRAJECTORY=false', async () => {
  serviceState.nearbyRows = [station()];
  process.env.ENABLE_TRAJECTORY = 'false';
  try {
    const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5' } };
    const res = mockRes();
    await stationController.getNearby(req, res, (e) => { throw e; });
    assert.equal(res.body.stations[0].trajectory, undefined);
    assert.equal(res.body.national_trajectory, null);
  } finally {
    delete process.env.ENABLE_TRAJECTORY;
  }
});

test('getNearby: preserves best_option + selected_reason (no regression)', async () => {
  serviceState.nearbyRows = [
    station({ id: 'a', distance_miles: 0.5, petrol_price: 160, e10_price: 158 }),
    station({ id: 'b', distance_miles: 2.0, petrol_price: 155, e10_price: 153 }),
  ];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5', fuel_type: 'petrol' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.ok(res.body.best_option, 'best_option must still be set');
  assert.ok(res.body.selected_reason, 'selected_reason must still be set');
});

test('getCheapest: break_even + trajectory + best_value all populate', async () => {
  serviceState.cheapestRows = [
    station({ id: 'a', distance_miles: 0.5, e10_price: 160 }),
    station({ id: 'b', distance_miles: 1.5, e10_price: 150 }),
  ];
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '10', mpg: '45', fuel_type: 'E10' } };
  const res = mockRes();
  await stationController.getCheapest(req, res, (e) => { throw e; });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.stations[0].break_even);
  assert.ok(res.body.stations[0].trajectory);
  assert.ok(res.body.best_value);
  assert.ok(res.body.national_trajectory);
});

// ── Flag endpoint integration ─────────────────────────────────────────

function makePriceFlagsStub() {
  const state = { flags: [], quarantines: [] };
  return { state, repo: {
    async hasRecentFlagFromDevice({ stationId, fuelType, deviceHash }) {
      return state.flags.some((f) => f.stationId === stationId && f.fuelType === fuelType && f.deviceHash === deviceHash);
    },
    async insertFlag(f) { state.flags.push(f); return { id: `f${state.flags.length}` }; },
    async countDistinctDevicesLastHour({ stationId, fuelType }) {
      const set = new Set();
      for (const f of state.flags) if (f.stationId === stationId && f.fuelType === fuelType) set.add(f.deviceHash);
      return set.size;
    },
    async upsertQuarantine({ stationId, fuelType }) { state.quarantines.push({ stationId, fuelType }); return {}; },
  }};
}

test('POST /flag-price: single flag → 200 received, not quarantined; 3rd flag → quarantined', async () => {
  // Patch the repository module inside the service via re-require.
  const servicePath = require.resolve('../src/services/priceFlagsService');
  delete require.cache[servicePath];
  const repoPath = require.resolve('../src/repositories/priceFlagsRepository');
  const stub = makePriceFlagsStub();
  require('module')._cache[repoPath] = { exports: stub.repo };
  delete require.cache[require.resolve('../src/controllers/priceFlagsController')];
  const pfc = require('../src/controllers/priceFlagsController');

  // First flag
  let req = { params: { stationId: 's-42' }, body: { fuel_type: 'E10', device_id: 'dev-a' } };
  let res = mockRes();
  await pfc.flagPrice(req, res, (e) => { throw e; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'received');
  assert.equal(res.body.flag_count_hour, 1);
  assert.equal(res.body.quarantined, false);

  // Second flag, different device
  req = { params: { stationId: 's-42' }, body: { fuel_type: 'E10', device_id: 'dev-b' } };
  res = mockRes();
  await pfc.flagPrice(req, res, (e) => { throw e; });
  assert.equal(res.body.flag_count_hour, 2);
  assert.equal(res.body.quarantined, false);

  // Third flag triggers quarantine
  req = { params: { stationId: 's-42' }, body: { fuel_type: 'E10', device_id: 'dev-c' } };
  res = mockRes();
  await pfc.flagPrice(req, res, (e) => { throw e; });
  assert.equal(res.body.flag_count_hour, 3);
  assert.equal(res.body.quarantined, true);
  assert.equal(stub.state.quarantines.length, 1);

  // 4th flag from dev-a within the same hour is deduped
  req = { params: { stationId: 's-42' }, body: { fuel_type: 'E10', device_id: 'dev-a' } };
  res = mockRes();
  await pfc.flagPrice(req, res, (e) => { throw e; });
  assert.equal(res.statusCode, 200);
  // No new insertion; flag row count should still be 3.
  assert.equal(stub.state.flags.length, 3);
});

test('POST /flag-price: 400 when device_id missing', async () => {
  const req = { params: { stationId: 's-42' }, body: { fuel_type: 'E10' } };
  const res = mockRes();
  await priceFlagsController.flagPrice(req, res, (e) => { throw e; });
  assert.equal(res.statusCode, 400);
});

test('POST /flag-price: 503 when ENABLE_PRICE_FLAGS=false', async () => {
  process.env.ENABLE_PRICE_FLAGS = 'false';
  try {
    const req = { params: { stationId: 's-42' }, body: { fuel_type: 'E10', device_id: 'dev-x' } };
    const res = mockRes();
    await priceFlagsController.flagPrice(req, res, (e) => { throw e; });
    assert.equal(res.statusCode, 503);
  } finally {
    delete process.env.ENABLE_PRICE_FLAGS;
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub pg and db module so requiring the repo/service doesn't open a pool
// or require a Postgres driver.
require('module')._cache[require.resolve('../src/config/db')] = {
  exports: { getPool: () => ({ query: async () => ({ rows: [] }) }) },
};

const priceFlagsService = require('../src/services/priceFlagsService');

function makeRepoStub() {
  const state = {
    flags: [], // { stationId, fuelType, deviceHash, reason, createdAt }
    quarantines: [], // { stationId, fuelType }
  };
  const repo = {
    async hasRecentFlagFromDevice({ stationId, fuelType, deviceHash }) {
      return state.flags.some(
        (f) => f.stationId === stationId
            && f.fuelType === fuelType
            && f.deviceHash === deviceHash,
      );
    },
    async insertFlag(flag) {
      state.flags.push({ ...flag, createdAt: Date.now() });
      return { id: `f${state.flags.length}`, created_at: new Date() };
    },
    async countDistinctDevicesLastHour({ stationId, fuelType }) {
      const set = new Set();
      for (const f of state.flags) {
        if (f.stationId === stationId && f.fuelType === fuelType) set.add(f.deviceHash);
      }
      return set.size;
    },
    async upsertQuarantine({ stationId, fuelType }) {
      state.quarantines.push({ stationId, fuelType });
      return { station_id: stationId, fuel_type: fuelType };
    },
  };
  return { repo, state };
}

test('hashDeviceId: deterministic + never returns raw value', () => {
  const h = priceFlagsService.hashDeviceId('abc-123-device');
  assert.equal(h.length, 64);
  assert.notEqual(h, 'abc-123-device');
  assert.equal(h, priceFlagsService.hashDeviceId('abc-123-device'));
});

test('processFlag: rejects missing stationId', async () => {
  const { repo } = makeRepoStub();
  const r = await priceFlagsService.processFlag({ repo }, {
    fuelType: 'E10', deviceId: 'd1',
  });
  assert.equal(r.status, 'invalid');
});

test('processFlag: rejects missing deviceId', async () => {
  const { repo } = makeRepoStub();
  const r = await priceFlagsService.processFlag({ repo }, {
    stationId: 's1', fuelType: 'E10',
  });
  assert.equal(r.status, 'invalid');
});

test('processFlag: rejects invalid fuel_type', async () => {
  const { repo } = makeRepoStub();
  const r = await priceFlagsService.processFlag({ repo }, {
    stationId: 's1', fuelType: 'SMOKE', deviceId: 'd1',
  });
  assert.equal(r.status, 'invalid');
});

test('processFlag: single flag returns received, not quarantined', async () => {
  const { repo, state } = makeRepoStub();
  const r = await priceFlagsService.processFlag({ repo }, {
    stationId: 's1', fuelType: 'E10', deviceId: 'd1',
  });
  assert.equal(r.status, 'received');
  assert.equal(r.flag_count_hour, 1);
  assert.equal(r.quarantined, false);
  assert.equal(state.flags.length, 1);
  // device_id should never appear raw in the stored flags.
  assert.equal(state.flags[0].deviceHash.length, 64);
  assert.notEqual(state.flags[0].deviceHash, 'd1');
});

test('processFlag: 3rd distinct device triggers quarantine', async () => {
  const { repo, state } = makeRepoStub();
  await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-a' });
  const r2 = await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-b' });
  assert.equal(r2.quarantined, false);
  const r3 = await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-c' });
  assert.equal(r3.flag_count_hour, 3);
  assert.equal(r3.quarantined, true);
  assert.equal(state.quarantines.length, 1);
  assert.equal(state.quarantines[0].stationId, 's1');
});

test('processFlag: dedup — same device within hour is a no-op insert', async () => {
  const { repo, state } = makeRepoStub();
  const a = await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-x' });
  const b = await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-x' });
  assert.equal(a.status, 'received');
  assert.equal(b.status, 'received');
  assert.equal(b.duplicate, true);
  assert.equal(state.flags.length, 1, 'dedup must keep a single row for same device');
});

test('processFlag: quarantine NOT triggered by 3 flags from same device', async () => {
  const { repo, state } = makeRepoStub();
  await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-x' });
  await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-x' });
  const r = await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-x' });
  assert.equal(r.quarantined, false);
  assert.equal(state.quarantines.length, 0);
});

test('processFlag: reason defaults to "wrong" and invalid reason is coerced', async () => {
  const { repo, state } = makeRepoStub();
  await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-a' });
  await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-b', reason: 'totally-bogus' });
  assert.equal(state.flags[0].reason, 'wrong');
  assert.equal(state.flags[1].reason, 'wrong');
});

test('processFlag: mixed-case fuel types E10/e10 normalise to same key', async () => {
  const { repo } = makeRepoStub();
  const a = await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'e10', deviceId: 'dev-a' });
  const b = await priceFlagsService.processFlag({ repo }, { stationId: 's1', fuelType: 'E10', deviceId: 'dev-a' });
  assert.equal(b.duplicate, true, 'same device should dedup across casing');
  assert.equal(a.flag_count_hour, 1);
});

// ── communityQuarantineService unit test ───────────────────────────────
const communityQuarantineService = require('../src/services/communityQuarantineService');

test('applyQuarantineMap: nulls e10_price when E10 quarantined', () => {
  const stations = [
    { id: 's1', e10_price: 150, petrol_price: 153, diesel_price: 160 },
    { id: 's2', e10_price: 151 },
  ];
  const map = new Map();
  map.set('s1', new Set(['E10']));
  const out = communityQuarantineService.applyQuarantineMap(stations, map);
  assert.equal(out[0].e10_price, null);
  assert.equal(out[0].petrol_price, 153); // untouched
  assert.deepEqual(out[0].community_quarantined_fuels, ['E10']);
  assert.equal(out[1].e10_price, 151); // other station untouched
});

test('applyQuarantineMap: no map returns input unchanged', () => {
  const stations = [{ id: 's1', e10_price: 150 }];
  const out = communityQuarantineService.applyQuarantineMap(stations, new Map());
  assert.equal(out[0].e10_price, 150);
});

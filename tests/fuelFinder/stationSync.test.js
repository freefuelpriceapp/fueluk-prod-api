'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { syncStations } = require('../../src/services/fuelFinder/stationSync');

function makePool() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
}

function makeStation(nodeId) {
  return {
    node_id: nodeId,
    trading_name: `Station ${nodeId}`,
    brand_name: 'TestBrand',
    location: { latitude: 52.1, longitude: -1.2, postcode: 'AB1 2CD' },
    is_motorway_service_station: false,
    is_supermarket_service_station: false,
    fuel_types: ['E10', 'B7_STANDARD'],
  };
}

function makeApiClient(batches) {
  const copy = [...batches];
  return {
    getStationsBatch: async () => copy.shift() || [],
  };
}

test('syncStations walks batches until under BATCH_SIZE', async () => {
  const pool = makePool();
  const batch1 = Array.from({ length: 500 }, (_, i) => makeStation(`a${i}`));
  const batch2 = Array.from({ length: 7 }, (_, i) => makeStation(`b${i}`));
  const apiClient = makeApiClient([batch1, batch2]);

  const result = await syncStations({ apiClient, pool });
  assert.equal(result.stationsSeen, 507);
  assert.equal(result.stationsUpserted, 507);
  // 507 upserts + 1 final state write
  const upserts = pool.queries.filter((q) => q.sql.includes('INSERT INTO stations'));
  assert.equal(upserts.length, 507);
});

test('syncStations stops on empty batch', async () => {
  const pool = makePool();
  const apiClient = makeApiClient([[]]);
  const result = await syncStations({ apiClient, pool });
  assert.equal(result.stationsSeen, 0);
  assert.equal(result.stationsUpserted, 0);
});

test('syncStations records error and stops after MAX_CONSECUTIVE_ERRORS when API throws', async () => {
  const pool = makePool();
  let calls = 0;
  const apiClient = {
    getStationsBatch: async () => { calls++; throw new Error('boom'); },
  };
  const result = await syncStations({ apiClient, pool });
  // With MAX_CONSECUTIVE_ERRORS=3, it should retry 3 times before aborting
  assert.equal(calls, 3);
  assert.equal(result.errors.length, 3);
  assert.equal(result.errors[0].message, 'boom');
  assert.equal(result.stationsUpserted, 0);
});

test('syncStations continues past a single batch failure to later batches', async () => {
  const pool = makePool();
  const goodBatch1 = Array.from({ length: 500 }, (_, i) => makeStation(`a${i}`));
  const goodBatch3 = Array.from({ length: 3 }, (_, i) => makeStation(`c${i}`));
  let call = 0;
  const apiClient = {
    getStationsBatch: async () => {
      call++;
      if (call === 1) return goodBatch1;
      if (call === 2) throw new Error('transient 403');
      if (call === 3) return goodBatch3;
      return [];
    },
  };
  const result = await syncStations({ apiClient, pool });
  assert.equal(result.stationsUpserted, 503, 'later batch processed despite middle failure');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].batch, 2);
});

test('syncStations skips stations missing node_id but keeps going', async () => {
  const pool = makePool();
  const bad = { trading_name: 'No ID' };
  const apiClient = makeApiClient([[bad, makeStation('good')]]);
  const result = await syncStations({ apiClient, pool });
  assert.equal(result.stationsUpserted, 1);
});

test('syncStations records errors from individual upserts', async () => {
  const pool = {
    queries: [],
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO stations')) throw new Error('db err');
      return { rowCount: 0, rows: [] };
    },
  };
  const apiClient = makeApiClient([[makeStation('x')]]);
  const result = await syncStations({ apiClient, pool });
  assert.equal(result.stationsUpserted, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].node_id, 'x');
});

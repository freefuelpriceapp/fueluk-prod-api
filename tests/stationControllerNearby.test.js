'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Intercept the stationService so we can assert what the controller passes in.
const servicePath = require.resolve('../src/services/stationService');
const calls = { getNearbyStations: [], getCheapestNearby: [] };
const fakeService = {
  async getNearbyStations(args) {
    calls.getNearbyStations.push(args);
    return [];
  },
  async getCheapestNearby(args) {
    calls.getCheapestNearby.push(args);
    return [];
  },
  async searchStations() { return []; },
  async getStationById() { return null; },
  async getDistinctBrands() { return []; },
};
require('module')._cache[servicePath] = { exports: fakeService };

const stationController = require('../src/controllers/stationController');

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('getNearby accepts radius_miles query param (preferred over radius)', async () => {
  calls.getNearbyStations.length = 0;
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '5' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.getNearbyStations.length, 1);
  assert.equal(calls.getNearbyStations[0].radius, 5);
  assert.equal(calls.getNearbyStations[0].lat, 52.4665);
  assert.equal(calls.getNearbyStations[0].lon, -1.8742);
});

test('getNearby still accepts legacy radius param', async () => {
  calls.getNearbyStations.length = 0;
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius: '7' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.equal(calls.getNearbyStations[0].radius, 7);
});

test('getNearby defaults radius to 5 miles when neither param provided', async () => {
  calls.getNearbyStations.length = 0;
  const req = { query: { lat: '52.4665', lon: '-1.8742' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.equal(calls.getNearbyStations[0].radius, 5);
});

test('getNearby returns 400 when lat/lon missing', async () => {
  const req = { query: { lat: '52.4665' } };
  const res = mockRes();
  await stationController.getNearby(req, res, (e) => { throw e; });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('getCheapest accepts radius_miles query param', async () => {
  calls.getCheapestNearby.length = 0;
  const req = { query: { lat: '52.4665', lon: '-1.8742', radius_miles: '8' } };
  const res = mockRes();
  await stationController.getCheapest(req, res, (e) => { throw e; });
  assert.equal(calls.getCheapestNearby[0].radius, 8);
});

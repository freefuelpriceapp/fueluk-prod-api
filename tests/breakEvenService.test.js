'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const breakEven = require('../src/services/breakEvenService');

function station(overrides = {}) {
  return {
    id: 'abc',
    distance_miles: 1.0,
    e10_price: 155.9,
    petrol_price: 158.9,
    diesel_price: 162.9,
    ...overrides,
  };
}

test('computeBreakEvenForStation returns null when price missing', () => {
  const s = station({ e10_price: null, petrol_price: null });
  assert.equal(breakEven.computeBreakEvenForStation(s, { fuelType: 'E10' }), null);
});

test('computeBreakEvenForStation: default tank=40L, user mpg', () => {
  const s = station({ e10_price: 150, distance_miles: 1.0 });
  const be = breakEven.computeBreakEvenForStation(s, { fuelType: 'E10', mpg: 45 });
  assert.equal(be.fuel_cost_full_tank, 60.0); // 40 × 150 / 100
  assert.equal(be.mpg_used, 45);
  assert.equal(be.mpg_source, 'user');
  assert.equal(be.tank_fill_litres, 40);
  // detour: 2 mi round-trip / 45 mpg × 4.546 L/gal × 150p / 100 = 0.30 (approx)
  assert.ok(be.detour_cost > 0.29 && be.detour_cost < 0.31);
  assert.equal(be.net_cost, be.fuel_cost_full_tank + be.detour_cost);
});

test('computeBreakEvenForStation: missing mpg falls back to default_e10', () => {
  const s = station({ e10_price: 150, distance_miles: 1.0 });
  const be = breakEven.computeBreakEvenForStation(s, { fuelType: 'E10' });
  assert.equal(be.mpg_used, 45);
  assert.equal(be.mpg_source, 'default_e10');
});

test('computeBreakEvenForStation: diesel (B7) default mpg is 55', () => {
  const s = station({ diesel_price: 160 });
  const be = breakEven.computeBreakEvenForStation(s, { fuelType: 'B7' });
  assert.equal(be.mpg_used, 55);
  assert.equal(be.mpg_source, 'default_b7');
});

test('computeBreakEvenForStation: custom tank_fill_litres', () => {
  const s = station({ e10_price: 150 });
  const be = breakEven.computeBreakEvenForStation(s, { fuelType: 'E10', tankFillLitres: 55 });
  assert.equal(be.tank_fill_litres, 55);
  assert.equal(be.fuel_cost_full_tank, 82.5); // 55 × 150 / 100
});

test('selectBestValueIndex: picks station with largest raw savings', () => {
  const stations = [
    station({ id: 'near',  distance_miles: 0.5, e10_price: 170 }),
    station({ id: 'mid',   distance_miles: 2.0, e10_price: 155 }),
    station({ id: 'far',   distance_miles: 5.0, e10_price: 150 }),
  ];
  const { breakEvens, bestValue } = breakEven.annotateBreakEven(stations, { fuelType: 'E10', mpg: 45 });
  // Nearest = index 0 at 170p. mid and far are cheaper by 15p and 20p/l on 40L fill.
  assert.equal(breakEvens.length, 3);
  assert.ok(bestValue !== null);
  // Expect "far" (index 2) to have highest savings on 40L fill (20p × 40 / 100 = £8 gross)
  assert.equal(bestValue.index, 2);
  assert.ok(bestValue.savings > 0);
});

test('selectBestValueIndex: returns null when nobody beats noise threshold', () => {
  const stations = [
    station({ id: 'a', distance_miles: 0.5, e10_price: 155.9 }),
    station({ id: 'b', distance_miles: 0.6, e10_price: 155.92 }),
  ];
  const { bestValue } = breakEven.annotateBreakEven(stations, { fuelType: 'E10', mpg: 45 });
  assert.equal(bestValue, null);
});

test('annotateBreakEven: savings_vs_nearest anchored to closest station', () => {
  const stations = [
    station({ id: 'near', distance_miles: 0.5, e10_price: 160 }),
    station({ id: 'far',  distance_miles: 3.0, e10_price: 150 }),
  ];
  const { breakEvens } = breakEven.annotateBreakEven(stations, { fuelType: 'E10', mpg: 45 });
  assert.equal(breakEvens[0].savings_vs_nearest, 0); // nearest is its own anchor
  assert.ok(breakEvens[1].savings_vs_nearest > 0);
  assert.ok(breakEvens[1].worth_the_drive === true);
  assert.match(breakEvens[1].savings_vs_nearest_formatted, /saved vs nearest/);
});

test('annotateBreakEven: worth_the_drive=false when savings < £0.10', () => {
  const stations = [
    station({ id: 'near', distance_miles: 0.5, e10_price: 156 }),
    station({ id: 'far',  distance_miles: 0.6, e10_price: 155.9 }),
  ];
  const { breakEvens } = breakEven.annotateBreakEven(stations, { fuelType: 'E10', mpg: 45 });
  assert.equal(breakEvens[1].worth_the_drive, false);
});

test('annotateBreakEven: stations without usable price get null block', () => {
  const stations = [
    station({ id: 'ok',      distance_miles: 0.5, e10_price: 150 }),
    station({ id: 'noprice', distance_miles: 1.0, e10_price: null, petrol_price: null }),
  ];
  const { breakEvens } = breakEven.annotateBreakEven(stations, { fuelType: 'E10', mpg: 45 });
  assert.ok(breakEvens[0] !== null);
  assert.equal(breakEvens[1], null);
});

test('annotateBreakEven: handles empty array', () => {
  const { breakEvens, bestValue } = breakEven.annotateBreakEven([], { fuelType: 'E10' });
  assert.deepEqual(breakEvens, []);
  assert.equal(bestValue, null);
});

test('selectBestValueIndex reason string contains £ and miles', () => {
  const stations = [
    station({ id: 'near', distance_miles: 0.5, e10_price: 170 }),
    station({ id: 'far',  distance_miles: 2.0, e10_price: 155 }),
  ];
  const { bestValue } = breakEven.annotateBreakEven(stations, { fuelType: 'E10', mpg: 45 });
  assert.match(bestValue.reason, /Saves £\d+\.\d{2} net after .* detour/);
});

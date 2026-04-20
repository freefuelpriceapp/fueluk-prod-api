'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineMiles } = require('../src/routes/trip');

test('haversineMiles: London → Manchester is ~163 miles (straight line)', () => {
  // London ~ 51.5074, -0.1278 ; Manchester ~ 53.4808, -2.2426
  const miles = haversineMiles(51.5074, -0.1278, 53.4808, -2.2426);
  assert.ok(miles > 155 && miles < 170, `expected ~163 miles, got ${miles}`);
});

test('haversineMiles: zero distance for identical points', () => {
  assert.equal(haversineMiles(51.5, -0.1, 51.5, -0.1), 0);
});

test('haversineMiles: symmetric', () => {
  const a = haversineMiles(51.5, -0.1, 53.5, -2.2);
  const b = haversineMiles(53.5, -2.2, 51.5, -0.1);
  assert.ok(Math.abs(a - b) < 1e-6);
});

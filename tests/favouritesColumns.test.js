'use strict';

/**
 * favouritesColumns.test.js — B-02
 *
 * Verifies that the GET /api/v1/favourites SELECT query includes the full
 * price column set: super_unleaded_price, premium_diesel_price,
 * opening_hours, is_motorway, is_supermarket.
 *
 * We do NOT start a real HTTP server — instead we read the route source
 * directly and assert on the SQL string it contains.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'favourites.js'),
  'utf8',
);

test('favourites SELECT includes super_unleaded_price', () => {
  assert.ok(
    routeSource.includes('super_unleaded_price'),
    'Expected super_unleaded_price in favourites SELECT',
  );
});

test('favourites SELECT includes premium_diesel_price', () => {
  assert.ok(
    routeSource.includes('premium_diesel_price'),
    'Expected premium_diesel_price in favourites SELECT',
  );
});

test('favourites SELECT includes opening_hours', () => {
  assert.ok(
    routeSource.includes('opening_hours'),
    'Expected opening_hours in favourites SELECT',
  );
});

test('favourites SELECT includes is_motorway', () => {
  assert.ok(
    routeSource.includes('is_motorway'),
    'Expected is_motorway in favourites SELECT',
  );
});

test('favourites SELECT includes is_supermarket', () => {
  assert.ok(
    routeSource.includes('is_supermarket'),
    'Expected is_supermarket in favourites SELECT',
  );
});

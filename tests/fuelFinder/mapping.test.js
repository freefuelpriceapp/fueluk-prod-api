'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  priceColumnForFuelType,
  sourceColumnForFuelType,
  sanitisePrice,
  stationToRow,
  pricesToColumnUpdates,
  SOURCE_TAG,
} = require('../../src/services/fuelFinder/mapping');

test('fuel type mapping covers the four Fuel Finder codes', () => {
  assert.equal(priceColumnForFuelType('E10'), 'e10_price');
  assert.equal(priceColumnForFuelType('E5'), 'super_unleaded_price');
  assert.equal(priceColumnForFuelType('B7_STANDARD'), 'diesel_price');
  assert.equal(priceColumnForFuelType('B7_PREMIUM'), 'premium_diesel_price');
  assert.equal(priceColumnForFuelType('UNKNOWN'), null);

  assert.equal(sourceColumnForFuelType('E10'), 'e10_source');
  assert.equal(sourceColumnForFuelType('E5'), 'super_unleaded_source');
});

test('sanitisePrice rejects nonsense and rounds to 1dp', () => {
  assert.equal(sanitisePrice(129.9), 129.9);
  assert.equal(sanitisePrice('136.45'), 136.5);
  assert.equal(sanitisePrice(null), null);
  assert.equal(sanitisePrice(undefined), null);
  assert.equal(sanitisePrice('oops'), null);
  assert.equal(sanitisePrice(0), null);
  assert.equal(sanitisePrice(1000), null);
});

test('stationToRow flattens the Fuel Finder station shape', () => {
  const row = stationToRow({
    node_id: 'abc123',
    trading_name: 'Shell Foobar',
    brand_name: 'Shell',
    temporary_closure: false,
    permanent_closure: false,
    is_motorway_service_station: true,
    is_supermarket_service_station: false,
    location: { latitude: 52.1, longitude: -1.2, postcode: 'B26 3QJ' },
    opening_times: { monday: '24h' },
    fuel_types: ['E10', 'E5', 'B7_STANDARD'],
    amenities: ['toilets'],
  });
  assert.equal(row.id, 'ff-abc123');
  assert.equal(row.fuel_finder_node_id, 'abc123');
  assert.equal(row.brand, 'Shell');
  assert.equal(row.name, 'Shell Foobar');
  assert.equal(row.postcode, 'B26 3QJ');
  assert.equal(row.is_motorway, true);
  assert.equal(row.is_supermarket, false);
  assert.equal(row.lat, 52.1);
  assert.equal(row.lng, -1.2);
  assert.deepEqual(row.fuel_types, ['E10', 'E5', 'B7_STANDARD']);
  assert.deepEqual(row.opening_hours, { monday: '24h' });
});

test('stationToRow returns null when node_id missing', () => {
  assert.equal(stationToRow(null), null);
  assert.equal(stationToRow({ trading_name: 'x' }), null);
});

test('stationToRow tolerates missing optional sections', () => {
  const row = stationToRow({ node_id: 'x' });
  assert.equal(row.id, 'ff-x');
  assert.equal(row.lat, null);
  assert.equal(row.lng, null);
  assert.equal(row.opening_hours, null);
});

test('pricesToColumnUpdates maps the four fuel codes and drops unknowns', () => {
  const updates = pricesToColumnUpdates({
    node_id: 's1',
    fuel_prices: [
      { fuel_type: 'E10', price: 129.9, price_last_updated: '2026-04-19T14:30:00Z' },
      { fuel_type: 'B7_STANDARD', price: 136.9, price_last_updated: '2026-04-19T14:30:05Z' },
      { fuel_type: 'E5', price: 139.9 },
      { fuel_type: 'B7_PREMIUM', price: 149.9 },
      { fuel_type: 'SOMETHING_NEW', price: 100 },
    ],
  });
  assert.equal(updates.length, 4);
  const byCol = Object.fromEntries(updates.map((u) => [u.priceColumn, u]));
  assert.equal(byCol.e10_price.price, 129.9);
  assert.equal(byCol.diesel_price.price, 136.9);
  assert.equal(byCol.super_unleaded_price.price, 139.9);
  assert.equal(byCol.premium_diesel_price.price, 149.9);
  assert.equal(byCol.e10_price.sourceColumn, 'e10_source');
});

test('pricesToColumnUpdates drops rows with unusable prices', () => {
  const updates = pricesToColumnUpdates({
    fuel_prices: [
      { fuel_type: 'E10', price: null },
      { fuel_type: 'B7_STANDARD', price: 999 },
    ],
  });
  assert.equal(updates.length, 0);
});

test('SOURCE_TAG is the stable string used in DB', () => {
  assert.equal(SOURCE_TAG, 'fuel_finder');
});

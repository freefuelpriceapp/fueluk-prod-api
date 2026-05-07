'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  quarantineStaleFields,
  mergeStations,
  PER_FIELD_QUARANTINE_HOURS,
} = require('../src/utils/stationQuarantine');

const NOW = Date.parse('2026-05-07T12:00:00Z');

function ageHoursAgo(hours) {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

function station(overrides = {}) {
  return {
    id: 'ff-12345',
    name: 'Apple Green Small Heath Highway',
    brand: 'Applegreen',
    postcode: 'B10 0AE',
    lat: 52.4775,
    lon: -1.8556,
    petrol_price: 139.8,
    diesel_price: 146.8,
    e10_price: 139.8,
    super_unleaded_price: null,
    premium_diesel_price: null,
    petrol_source: 'fuel_finder',
    diesel_source: 'fuel_finder',
    e10_source: 'fuel_finder',
    super_unleaded_source: null,
    premium_diesel_source: null,
    petrol_updated_at: ageHoursAgo(2),
    diesel_updated_at: ageHoursAgo(2),
    e10_updated_at: ageHoursAgo(2),
    super_unleaded_updated_at: null,
    premium_diesel_updated_at: null,
    last_updated: ageHoursAgo(2),
    ...overrides,
  };
}

test('quarantineStaleFields leaves fresh fields alone', () => {
  const [out] = quarantineStaleFields([station()], { now: NOW });
  assert.equal(out.petrol_price, 139.8);
  assert.equal(out.petrol_price_quarantined, false);
  assert.equal(out.diesel_price, 146.8);
  assert.equal(out.diesel_price_quarantined, false);
});

test('quarantineStaleFields nulls a stale field but preserves the prior value', () => {
  // Reproduces B10 0AE case: 140p super unleaded last touched > 1 year ago.
  const stuck = station({
    super_unleaded_price: 140.0,
    super_unleaded_source: 'applegreen_official',
    super_unleaded_updated_at: ageHoursAgo(24 * 400),
  });
  const [out] = quarantineStaleFields([stuck], { now: NOW });
  assert.equal(out.super_unleaded_price, null, 'live price is cleared');
  assert.equal(out.super_unleaded_price_quarantined, true);
  assert.equal(out.super_unleaded_price_quarantined_value, 140.0,
    'historical value is preserved for the UI to display distinctly');
  assert.match(out.super_unleaded_price_quarantine_reason, /stale_over_24h/);
});

test('quarantineStaleFields never hides the station — id and identity persist', () => {
  const stuck = station({
    super_unleaded_price: 140.0,
    super_unleaded_updated_at: ageHoursAgo(24 * 400),
  });
  const [out] = quarantineStaleFields([stuck], { now: NOW });
  assert.equal(out.id, 'ff-12345');
  assert.equal(out.postcode, 'B10 0AE');
  assert.equal(out.brand, 'Applegreen');
  assert.equal(out.lat, 52.4775);
});

test('quarantineStaleFields treats a null price field as not quarantined', () => {
  const s = station();
  const [out] = quarantineStaleFields([s], { now: NOW });
  assert.equal(out.super_unleaded_price, null);
  assert.equal(out.super_unleaded_price_quarantined, false);
});

test('quarantineStaleFields uses station-wide last_updated as a fallback', () => {
  const s = station({
    petrol_updated_at: null,
    last_updated: ageHoursAgo(48),
  });
  const [out] = quarantineStaleFields([s], { now: NOW });
  assert.equal(out.petrol_price, null);
  assert.equal(out.petrol_price_quarantined, true);
});

test('quarantineStaleFields flags a price whose timestamp is missing entirely', () => {
  const s = station({
    petrol_updated_at: null,
    last_updated: null,
  });
  const [out] = quarantineStaleFields([s], { now: NOW });
  assert.equal(out.petrol_price_quarantined, true);
  assert.match(out.petrol_price_quarantine_reason, /no_timestamp/);
});

test('quarantineStaleFields respects a custom quarantineHours threshold', () => {
  const s = station({ petrol_updated_at: ageHoursAgo(6) });
  const [strict] = quarantineStaleFields([s], { now: NOW, quarantineHours: 1 });
  const [loose] = quarantineStaleFields([s], { now: NOW, quarantineHours: 12 });
  assert.equal(strict.petrol_price_quarantined, true);
  assert.equal(loose.petrol_price_quarantined, false);
});

test('PER_FIELD_QUARANTINE_HOURS default is 24h', () => {
  assert.equal(PER_FIELD_QUARANTINE_HOURS, 24);
});

// ---------------------------------------------------------------------------
// Source priority: Fuel Finder beats Apple Green.

test('mergeStations: fuel_finder petrol price wins over a stale brand-direct value', () => {
  const ff = {
    id: 'ff-1',
    petrol_price: 138.9,
    petrol_source: 'fuel_finder',
    petrol_updated_at: ageHoursAgo(0.1),
    diesel_price: null,
    e10_price: null,
    super_unleaded_price: null,
    premium_diesel_price: null,
    last_updated: ageHoursAgo(0.1),
    postcode: 'B10 0AE',
    lat: 52.4775,
    lon: -1.8556,
  };
  const gov = {
    id: 'gcq-1',
    petrol_price: 140.0,
    petrol_source: 'applegreen_official',
    petrol_updated_at: ageHoursAgo(24 * 30),
    diesel_price: null,
    e10_price: null,
    super_unleaded_price: null,
    premium_diesel_price: null,
    last_updated: ageHoursAgo(24 * 30),
    postcode: 'B10 0AE',
    lat: 52.4775,
    lon: -1.8556,
  };
  const merged = mergeStations(gov, ff);
  assert.equal(merged.petrol_price, 138.9);
  assert.equal(merged.petrol_source, 'fuel_finder');
  assert.equal(merged.petrol_updated_at, ff.petrol_updated_at,
    'merged record carries the per-field timestamp from the winning source');
});

test('mergeStations: gov fills standard fuels when fuel_finder side is null', () => {
  const ff = {
    id: 'ff-1',
    petrol_price: null,
    petrol_source: null,
    petrol_updated_at: null,
    diesel_price: null,
    e10_price: null,
    super_unleaded_price: 165.9,
    super_unleaded_source: 'fuel_finder',
    super_unleaded_updated_at: ageHoursAgo(0.5),
    premium_diesel_price: null,
    last_updated: ageHoursAgo(0.5),
    postcode: 'B10 0AE',
    lat: 52.4775,
    lon: -1.8556,
  };
  const gov = {
    id: 'gcq-1',
    petrol_price: 139.8,
    petrol_source: 'applegreen_official',
    petrol_updated_at: ageHoursAgo(8),
    diesel_price: 146.8,
    diesel_source: 'applegreen_official',
    diesel_updated_at: ageHoursAgo(8),
    e10_price: null,
    super_unleaded_price: null,
    premium_diesel_price: null,
    last_updated: ageHoursAgo(8),
    postcode: 'B10 0AE',
    lat: 52.4775,
    lon: -1.8556,
  };
  const merged = mergeStations(gov, ff);
  assert.equal(merged.petrol_price, 139.8, 'gov fills when fuel_finder absent');
  assert.equal(merged.petrol_source, 'applegreen_official');
  assert.equal(merged.super_unleaded_price, 165.9, 'fuel_finder still wins for premium fuels');
  assert.equal(merged.super_unleaded_source, 'fuel_finder');
});

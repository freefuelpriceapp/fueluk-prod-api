'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deduplicateStations,
  sanitizeStationPrices,
  mergeStations,
} = require('../src/utils/stationQuarantine');

const silentLogger = { warn: () => {} };

function gov(overrides = {}) {
  return {
    id: 'gcqdmx4vbbt3',
    name: 'Applegreen',
    brand: 'Applegreen',
    postcode: 'B10 0AE',
    lat: 52.4775,
    lon: -1.8556,
    petrol_price: 154.9,
    diesel_price: 160.9,
    e10_price: 154.9,
    super_unleaded_price: null,
    premium_diesel_price: null,
    petrol_source: 'gov',
    diesel_source: 'gov',
    e10_source: 'gov',
    super_unleaded_source: null,
    premium_diesel_source: null,
    last_updated: '2026-04-19T08:00:00Z',
    opening_hours: null,
    amenities: [],
    ...overrides,
  };
}

function ff(overrides = {}) {
  return {
    id: 'ff-12345',
    name: 'Applegreen B10',
    brand: 'Applegreen',
    postcode: 'B10 0AE',
    lat: 52.4776,
    lon: -1.8555,
    petrol_price: 153.9,
    diesel_price: 159.9,
    e10_price: 153.9,
    super_unleaded_price: 169.9,
    premium_diesel_price: 172.9,
    petrol_source: 'fuel_finder',
    diesel_source: 'fuel_finder',
    e10_source: 'fuel_finder',
    super_unleaded_source: 'fuel_finder',
    premium_diesel_source: 'fuel_finder',
    last_updated: '2026-04-20T12:30:00Z',
    opening_hours: { mon: '06:00-22:00' },
    amenities: ['carwash', 'atm'],
    ...overrides,
  };
}

test('deduplicateStations merges gov+ff pair on matching postcode and near coords', () => {
  const out = deduplicateStations([gov(), ff()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ff-12345', 'fuel_finder ID is kept as primary');
  assert.equal(out[0].super_unleaded_price, 169.9);
  assert.equal(out[0].premium_diesel_price, 172.9);
  assert.equal(out[0].petrol_price, 153.9, 'fuel_finder wins when both sides have a standard price');
  assert.equal(out[0].petrol_source, 'fuel_finder');
  assert.deepEqual(out[0].amenities, ['carwash', 'atm']);
  assert.deepEqual(out[0].opening_hours, { mon: '06:00-22:00' });
});

test('deduplicateStations falls back to gov standard fuels when fuel_finder is missing them', () => {
  const ffNoStandard = ff({ petrol_price: null, petrol_source: null, e10_price: null, e10_source: null });
  const out = deduplicateStations([gov(), ffNoStandard]);
  assert.equal(out.length, 1);
  assert.equal(out[0].petrol_price, 154.9);
  assert.equal(out[0].petrol_source, 'gov');
});

test('deduplicateStations does not merge when postcodes differ', () => {
  const a = gov({ postcode: 'B10 0AE' });
  const b = ff({ postcode: 'B10 0AF' });
  const out = deduplicateStations([a, b]);
  assert.equal(out.length, 2);
});

test('deduplicateStations does not merge when coordinates are > 0.0005 apart', () => {
  const a = gov({ lat: 52.4775, lon: -1.8556 });
  const b = ff({ lat: 52.4800, lon: -1.8556 });
  const out = deduplicateStations([a, b]);
  assert.equal(out.length, 2);
});

test('deduplicateStations merges three candidates (gov+gov+ff) into one record', () => {
  const govA = gov({ id: 'gcqdmx4vbbt3' });
  const govB = gov({ id: 'gcqdmx4ghd51', lat: 52.4776, lon: -1.8557, petrol_price: 155.9 });
  const ffOne = ff({ id: 'ff-99' });
  const out = deduplicateStations([govA, govB, ffOne]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ff-99');
});

test('deduplicateStations preserves stations with missing postcode without merging', () => {
  const a = gov({ postcode: null });
  const b = ff({ postcode: null });
  const out = deduplicateStations([a, b]);
  assert.equal(out.length, 2);
});

test('deduplicateStations picks the nearer distance_miles from the pair', () => {
  const a = gov({ distance_miles: 2.4 });
  const b = ff({ distance_miles: 1.1 });
  const out = deduplicateStations([a, b]);
  assert.equal(out[0].distance_miles, 1.1);
});

test('deduplicateStations takes the newer last_updated', () => {
  const older = gov({ last_updated: '2026-04-01T00:00:00Z' });
  const newer = ff({ last_updated: '2026-04-20T12:30:00Z' });
  const out = deduplicateStations([older, newer]);
  assert.equal(out[0].last_updated, '2026-04-20T12:30:00Z');
});

test('deduplicateStations treats a one-element list as a no-op', () => {
  const stations = [gov()];
  const out = deduplicateStations(stations);
  assert.equal(out.length, 1);
  assert.equal(out[0], stations[0]);
});

test('deduplicateStations returns an empty array when input is not an array', () => {
  assert.deepEqual(deduplicateStations(null), []);
  assert.deepEqual(deduplicateStations(undefined), []);
});

test('mergeStations without a fuel_finder side picks the fresher price', () => {
  const a = gov({ petrol_price: 154.9, last_updated: '2026-04-20T12:00:00Z' });
  const b = gov({ id: 'gcq-other', petrol_price: 156.9, last_updated: '2026-04-18T09:00:00Z' });
  const merged = mergeStations(a, b);
  assert.equal(merged.petrol_price, 154.9);
});

test('sanitizeStationPrices nullifies prices below 110p/L', () => {
  const out = sanitizeStationPrices(
    [gov({ petrol_price: 100, e10_price: 99.9 })],
    { logger: silentLogger },
  );
  assert.equal(out[0].petrol_price, null);
  assert.equal(out[0].e10_price, null);
  assert.equal(out[0].diesel_price, 160.9, 'valid prices are untouched');
});

test('sanitizeStationPrices nullifies prices above 300p/L', () => {
  const out = sanitizeStationPrices(
    [gov({ diesel_price: 350 })],
    { logger: silentLogger },
  );
  assert.equal(out[0].diesel_price, null);
});

test('sanitizeStationPrices keeps prices at the 110 and 300 boundaries', () => {
  const out = sanitizeStationPrices(
    [gov({ petrol_price: 110, diesel_price: 300 })],
    { logger: silentLogger },
  );
  assert.equal(out[0].petrol_price, 110);
  assert.equal(out[0].diesel_price, 300);
});

test('sanitizeStationPrices leaves null prices alone and returns original object when unchanged', () => {
  const station = gov({ petrol_price: null });
  const [out] = sanitizeStationPrices([station], { logger: silentLogger });
  assert.equal(out, station);
  assert.equal(out.petrol_price, null);
});

test('sanitizeStationPrices logs via the provided logger when quarantining', () => {
  const calls = [];
  const logger = { warn: (msg) => calls.push(msg) };
  sanitizeStationPrices(
    [gov({ id: 'asda-swanley', postcode: 'BR8 8AF', petrol_price: 100 })],
    { logger },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Dropped petrol_price=100/);
  assert.match(calls[0], /asda-swanley/);
  assert.match(calls[0], /BR8 8AF/);
});

test('sanitizeStationPrices handles non-array input', () => {
  assert.deepEqual(sanitizeStationPrices(null), []);
});

test('sanitize + dedup compose: a bogus gov price drops out so fuel_finder wins cleanly', () => {
  const govBad = gov({ petrol_price: 100 });
  const ffGood = ff({ petrol_price: 153.9 });
  const sanitized = sanitizeStationPrices([govBad, ffGood], { logger: silentLogger });
  const out = deduplicateStations(sanitized);
  assert.equal(out.length, 1);
  assert.equal(out[0].petrol_price, 153.9);
  assert.equal(out[0].petrol_source, 'fuel_finder');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deduplicateStations,
  sanitizeStationPrices,
  validateCrossFuelPrices,
  annotateStations,
  isSupermarketBrand,
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

test('isSupermarketBrand matches known supermarket names case- and punctuation-insensitively', () => {
  assert.equal(isSupermarketBrand('Asda'), true);
  assert.equal(isSupermarketBrand('ASDA'), true);
  assert.equal(isSupermarketBrand('ASDA EXPRESS'), true);
  assert.equal(isSupermarketBrand('TESCO'), true);
  assert.equal(isSupermarketBrand('Tesco'), true);
  assert.equal(isSupermarketBrand("Sainsbury's"), true);
  assert.equal(isSupermarketBrand('SAINSBURYS'), true);
  assert.equal(isSupermarketBrand('MORRISONS'), true);
  assert.equal(isSupermarketBrand('Morrisons'), true);
  assert.equal(isSupermarketBrand('COSTCO WHOLESALE'), true);
  assert.equal(isSupermarketBrand('Costco'), true);
});

test('isSupermarketBrand returns false for non-supermarket brands', () => {
  assert.equal(isSupermarketBrand('BP'), false);
  assert.equal(isSupermarketBrand('Shell'), false);
  assert.equal(isSupermarketBrand('Applegreen'), false);
  assert.equal(isSupermarketBrand(null), false);
  assert.equal(isSupermarketBrand(''), false);
});

test('annotateStations sets is_supermarket for supermarket brands', () => {
  const stations = [
    { id: '1', brand: 'Asda', last_updated: null },
    { id: '2', brand: "Sainsbury's", last_updated: null },
    { id: '3', brand: 'BP', last_updated: null },
  ];
  const out = annotateStations(stations);
  assert.equal(out[0].is_supermarket, true);
  assert.equal(out[1].is_supermarket, true);
  assert.equal(out[2].is_supermarket, false);
});

test('annotateStations preserves pre-existing is_supermarket=true even for unknown brands', () => {
  const stations = [{ id: '1', brand: 'Some Indie', is_supermarket: true, last_updated: null }];
  const out = annotateStations(stations);
  assert.equal(out[0].is_supermarket, true);
});

test('annotateStations computes price_age_hours and stale flag', () => {
  const now = Date.parse('2026-04-20T12:00:00Z');
  const stations = [
    { id: 'fresh', last_updated: '2026-04-20T11:00:00Z' },
    { id: 'day-old', last_updated: '2026-04-19T12:00:00Z' },
    { id: 'stale', last_updated: '2026-04-17T11:00:00Z' },
  ];
  const out = annotateStations(stations, { staleThresholdHours: 48, now });
  assert.equal(out[0].price_age_hours, 1);
  assert.equal(out[0].stale, false);
  assert.equal(out[1].price_age_hours, 24);
  assert.equal(out[1].stale, false);
  assert.equal(out[2].price_age_hours, 73);
  assert.equal(out[2].stale, true);
});

test('annotateStations respects custom stale_threshold_hours', () => {
  const now = Date.parse('2026-04-20T12:00:00Z');
  const stations = [{ id: '1', last_updated: '2026-04-20T06:00:00Z' }];
  const strict = annotateStations(stations, { staleThresholdHours: 1, now });
  const loose = annotateStations(stations, { staleThresholdHours: 24, now });
  assert.equal(strict[0].stale, true);
  assert.equal(loose[0].stale, false);
});

test('annotateStations returns null price_age_hours when last_updated is missing', () => {
  const out = annotateStations([{ id: '1', last_updated: null }]);
  assert.equal(out[0].price_age_hours, null);
  assert.equal(out[0].stale, false);
});

test('validateCrossFuelPrices nulls petrol_price when E5 < E10', () => {
  const calls = [];
  const logger = { warn: (m) => calls.push(m) };
  const out = validateCrossFuelPrices(
    [gov({ id: 'asda-bow', postcode: 'E3 2AN', petrol_price: 138.9, e10_price: 157.9 })],
    { logger },
  );
  assert.equal(out[0].petrol_price, null);
  assert.equal(out[0].e10_price, 157.9, 'E10 is untouched');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /E5<E10/);
  assert.match(calls[0], /asda-bow/);
});

test('validateCrossFuelPrices leaves prices alone when E5 >= E10', () => {
  const station = gov({ petrol_price: 160.9, e10_price: 154.9 });
  const [out] = validateCrossFuelPrices([station], { logger: silentLogger });
  assert.equal(out, station, 'returns original object when unchanged');
  assert.equal(out.petrol_price, 160.9);
});

test('validateCrossFuelPrices nulls premium_diesel_price when premium < diesel', () => {
  const calls = [];
  const logger = { warn: (m) => calls.push(m) };
  const out = validateCrossFuelPrices(
    [ff({ diesel_price: 165.9, premium_diesel_price: 155.9 })],
    { logger },
  );
  assert.equal(out[0].premium_diesel_price, null);
  assert.equal(out[0].diesel_price, 165.9);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /premium<diesel/);
});

test('validateCrossFuelPrices ignores stations missing one side of the pair', () => {
  const s = gov({ petrol_price: 120, e10_price: null });
  const [out] = validateCrossFuelPrices([s], { logger: silentLogger });
  assert.equal(out, s);
  assert.equal(out.petrol_price, 120);
});

test('validateCrossFuelPrices handles both inversions on the same station', () => {
  const calls = [];
  const logger = { warn: (m) => calls.push(m) };
  const out = validateCrossFuelPrices(
    [ff({ petrol_price: 150, e10_price: 155, diesel_price: 170, premium_diesel_price: 160 })],
    { logger },
  );
  assert.equal(out[0].petrol_price, null);
  assert.equal(out[0].premium_diesel_price, null);
  assert.equal(out[0].e10_price, 155);
  assert.equal(out[0].diesel_price, 170);
  assert.equal(calls.length, 2);
});

test('validateCrossFuelPrices handles non-array input', () => {
  assert.deepEqual(validateCrossFuelPrices(null), []);
});

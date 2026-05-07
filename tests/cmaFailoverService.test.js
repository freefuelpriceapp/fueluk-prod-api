'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const cmaFailoverService = require('../src/services/cmaFailoverService');

function flagOn() { process.env.FEATURE_CMA_FAILOVER = 'true'; }
function flagOff() { delete process.env.FEATURE_CMA_FAILOVER; }
function reset() { cmaFailoverService.clearSnapshot(); }

const NOW = new Date('2026-05-07T12:00:00Z').getTime();
const FRESH = new Date('2026-05-07T10:00:00Z').toISOString(); // 2h ago
const STALE = new Date('2026-05-05T10:00:00Z').toISOString(); // ~50h ago

function staleStation(overrides = {}) {
  return {
    id: 'st-1',
    brand: 'Asda',
    lat: 52.4862,
    lon: -1.8904,
    petrol_price: null,
    petrol_price_quarantined: true,
    petrol_price_quarantine_reason: 'stale_over_24h',
    petrol_price_quarantined_value: 145.9,
    petrol_updated_at: STALE,
    diesel_price: null,
    diesel_price_quarantined: true,
    diesel_price_quarantine_reason: 'stale_over_24h',
    diesel_updated_at: STALE,
    e10_price: null,
    e10_price_quarantined: true,
    e10_price_quarantine_reason: 'stale_over_24h',
    e10_updated_at: STALE,
    ...overrides,
  };
}

test('flag off: stamps source_used=fuel_finder and does NOT inject CMA prices', () => {
  flagOff(); reset();
  cmaFailoverService.recordSnapshot({
    brand: 'Asda', lat: 52.4862, lon: -1.8904,
    prices: { petrol_price: 142.9, diesel_price: 152.9, e10_price: 140.9 },
    fetchedAt: NOW - 60_000,
  });
  const out = cmaFailoverService.applyCmaFailover([staleStation()], { now: NOW });
  assert.equal(out[0].source_used, 'fuel_finder');
  assert.equal(out[0].petrol_price, null, 'flag off must not inject CMA price');
  assert.equal(out[0].petrol_price_quarantined, true);
});

test('flag on: fuel_finder stale + CMA fresh → CMA used', () => {
  flagOn(); reset();
  cmaFailoverService.recordSnapshot({
    brand: 'Asda', lat: 52.4862, lon: -1.8904,
    prices: { petrol_price: 142.9, diesel_price: 152.9, e10_price: 140.9 },
    fetchedAt: NOW - 60_000,
  });
  const out = cmaFailoverService.applyCmaFailover([staleStation()], { now: NOW });
  assert.equal(out[0].petrol_price, 142.9);
  assert.equal(out[0].petrol_price_quarantined, false);
  assert.equal(out[0].petrol_source, 'cma');
  assert.equal(out[0].source_used, 'cma');
  flagOff();
});

test('flag on: both stale (no CMA snapshot) → fields stay null, source_used=fuel_finder', () => {
  flagOn(); reset();
  // No snapshot recorded → no failover possible.
  const out = cmaFailoverService.applyCmaFailover([staleStation()], { now: NOW });
  assert.equal(out[0].petrol_price, null);
  assert.equal(out[0].petrol_price_quarantined, true);
  assert.equal(out[0].source_used, 'fuel_finder');
  flagOff();
});

test('flag on: both fresh → fuel_finder wins (no CMA injection)', () => {
  flagOn(); reset();
  cmaFailoverService.recordSnapshot({
    brand: 'Asda', lat: 52.4862, lon: -1.8904,
    prices: { petrol_price: 142.9 },
    fetchedAt: NOW - 60_000,
  });
  const fresh = {
    id: 'st-2',
    brand: 'Asda',
    lat: 52.4862,
    lon: -1.8904,
    petrol_price: 145.9,
    petrol_price_quarantined: false,
    petrol_updated_at: FRESH,
  };
  const out = cmaFailoverService.applyCmaFailover([fresh], { now: NOW });
  assert.equal(out[0].petrol_price, 145.9);
  assert.equal(out[0].source_used, 'fuel_finder');
  flagOff();
});

test('flag on: brand mismatch → no CMA injection (no Esso → Shell pollution)', () => {
  flagOn(); reset();
  cmaFailoverService.recordSnapshot({
    brand: 'Esso', lat: 52.4862, lon: -1.8904,
    prices: { petrol_price: 142.9 },
    fetchedAt: NOW - 60_000,
  });
  const shellStation = staleStation({ brand: 'Shell' });
  const out = cmaFailoverService.applyCmaFailover([shellStation], { now: NOW });
  assert.equal(out[0].petrol_price, null, 'cross-brand snapshot must NOT be injected');
  assert.equal(out[0].petrol_price_quarantined, true);
  assert.equal(out[0].source_used, 'fuel_finder');
  flagOff();
});

test('flag on: snapshot older than TTL → not used', () => {
  flagOn(); reset();
  cmaFailoverService.recordSnapshot({
    brand: 'Asda', lat: 52.4862, lon: -1.8904,
    prices: { petrol_price: 142.9 },
    fetchedAt: NOW - cmaFailoverService.SNAPSHOT_TTL_MS - 60_000,
  });
  const out = cmaFailoverService.applyCmaFailover([staleStation()], { now: NOW });
  assert.equal(out[0].petrol_price, null);
  assert.equal(out[0].source_used, 'fuel_finder');
  flagOff();
});

test('flag on: mixed — one field fresh from fuel_finder, one quarantined → source_used=mixed', () => {
  flagOn(); reset();
  cmaFailoverService.recordSnapshot({
    brand: 'Asda', lat: 52.4862, lon: -1.8904,
    prices: { diesel_price: 152.9 },
    fetchedAt: NOW - 60_000,
  });
  const station = {
    id: 'mixed',
    brand: 'Asda',
    lat: 52.4862,
    lon: -1.8904,
    petrol_price: 145.9,
    petrol_price_quarantined: false,
    petrol_updated_at: FRESH,
    diesel_price: null,
    diesel_price_quarantined: true,
    diesel_price_quarantine_reason: 'stale_over_24h',
    diesel_updated_at: STALE,
  };
  const out = cmaFailoverService.applyCmaFailover([station], { now: NOW });
  assert.equal(out[0].petrol_price, 145.9);
  assert.equal(out[0].diesel_price, 152.9);
  assert.equal(out[0].diesel_source, 'cma');
  assert.equal(out[0].source_used, 'mixed');
  flagOff();
});

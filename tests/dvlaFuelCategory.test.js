'use strict';
/**
 * Wave A.8 — tests for src/utils/dvlaFuelCategory.js
 *
 * Covers the five canonical categories (diesel, unleaded, electric, hybrid,
 * unknown/empty) plus edge cases required by the spec.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapDvlaToFuelCategory, deriveFuelFields } = require('../src/utils/dvlaFuelCategory');

// ── mapDvlaToFuelCategory ────────────────────────────────────────────────────

test('DIESEL → "diesel"', () => {
  assert.equal(mapDvlaToFuelCategory('DIESEL'), 'diesel');
});

test('diesel (lowercase) → "diesel"', () => {
  assert.equal(mapDvlaToFuelCategory('diesel'), 'diesel');
});

test('PETROL → "unleaded"', () => {
  assert.equal(mapDvlaToFuelCategory('PETROL'), 'unleaded');
});

test('GASOLINE → "unleaded"', () => {
  assert.equal(mapDvlaToFuelCategory('GASOLINE'), 'unleaded');
});

test('HYBRID ELECTRIC → "unleaded" (hybrids burn 95-RON at pump)', () => {
  assert.equal(mapDvlaToFuelCategory('HYBRID ELECTRIC'), 'unleaded');
});

test('HYBRID → "unleaded"', () => {
  assert.equal(mapDvlaToFuelCategory('HYBRID'), 'unleaded');
});

test('PHEV → "unleaded"', () => {
  assert.equal(mapDvlaToFuelCategory('PHEV'), 'unleaded');
});

test('PETROL/ELECTRIC → "unleaded"', () => {
  assert.equal(mapDvlaToFuelCategory('PETROL/ELECTRIC'), 'unleaded');
});

test('ELECTRICITY → "electric"', () => {
  assert.equal(mapDvlaToFuelCategory('ELECTRICITY'), 'electric');
});

test('ELECTRIC → "electric"', () => {
  assert.equal(mapDvlaToFuelCategory('ELECTRIC'), 'electric');
});

test('EV → "electric"', () => {
  assert.equal(mapDvlaToFuelCategory('EV'), 'electric');
});

test('BEV → "electric"', () => {
  assert.equal(mapDvlaToFuelCategory('BEV'), 'electric');
});

test('unknown string → null', () => {
  assert.equal(mapDvlaToFuelCategory('HYDROGEN'), null);
});

test('empty string → null', () => {
  assert.equal(mapDvlaToFuelCategory(''), null);
});

test('null → null', () => {
  assert.equal(mapDvlaToFuelCategory(null), null);
});

test('undefined → null', () => {
  assert.equal(mapDvlaToFuelCategory(undefined), null);
});

// ── deriveFuelFields ─────────────────────────────────────────────────────────

test('deriveFuelFields DIESEL returns both fields', () => {
  const { fuel_type, fuel_category } = deriveFuelFields('DIESEL');
  assert.equal(fuel_type, 'diesel');
  assert.equal(fuel_category, 'diesel');
});

test('deriveFuelFields PETROL returns both fields', () => {
  const { fuel_type, fuel_category } = deriveFuelFields('PETROL');
  assert.equal(fuel_type, 'petrol');
  assert.equal(fuel_category, 'unleaded');
});

test('deriveFuelFields HYBRID ELECTRIC returns both fields', () => {
  const { fuel_type, fuel_category } = deriveFuelFields('HYBRID ELECTRIC');
  assert.equal(fuel_type, 'hybrid electric');
  assert.equal(fuel_category, 'unleaded');
});

test('deriveFuelFields ELECTRICITY returns both fields', () => {
  const { fuel_type, fuel_category } = deriveFuelFields('ELECTRICITY');
  assert.equal(fuel_type, 'electricity');
  assert.equal(fuel_category, 'electric');
});

test('deriveFuelFields unknown value returns null category', () => {
  const { fuel_type, fuel_category } = deriveFuelFields('HYDROGEN');
  assert.equal(fuel_type, 'hydrogen');
  assert.equal(fuel_category, null);
});

test('deriveFuelFields null input returns null/null', () => {
  const { fuel_type, fuel_category } = deriveFuelFields(null);
  assert.equal(fuel_type, null);
  assert.equal(fuel_category, null);
});

// ── Integration: vehicle lookup response shape ───────────────────────────────

test('vehicleCheckService.toUnifiedResponse includes fuel_type and fuel_category', () => {
  const { toUnifiedResponse } = require('../src/services/vehicleCheckService');
  const dvlaResult = {
    available: true,
    data: {
      registrationNumber: 'RK65XKY',
      make: 'VOLKSWAGEN',
      model: 'GOLF',
      fuelType: 'DIESEL',
      engineCapacity: 1968,
    },
  };
  const motResult = { available: false, data: null };
  const specResult = { data: null, error: null };

  const resp = toUnifiedResponse('RK65XKY', dvlaResult, motResult, specResult);
  assert.equal(resp.fuelType, 'DIESEL',   'fuelType (camelCase) must be preserved for backwards compat');
  assert.equal(resp.fuel_type, 'diesel',  'fuel_type must be lowercased DVLA value');
  assert.equal(resp.fuel_category, 'diesel', 'fuel_category must be canonical taxonomy key');
});

test('toUnifiedResponse with HYBRID ELECTRIC → fuel_category unleaded', () => {
  const { toUnifiedResponse } = require('../src/services/vehicleCheckService');
  const dvlaResult = {
    available: true,
    data: { registrationNumber: 'AB12CDE', fuelType: 'HYBRID ELECTRIC', engineCapacity: 1798 },
  };
  const resp = toUnifiedResponse('AB12CDE', dvlaResult, { available: false, data: null }, { data: null, error: null });
  assert.equal(resp.fuel_category, 'unleaded');
  assert.equal(resp.fuel_type, 'hybrid electric');
});

test('toUnifiedResponse with ELECTRICITY → fuel_category electric', () => {
  const { toUnifiedResponse } = require('../src/services/vehicleCheckService');
  const dvlaResult = {
    available: true,
    data: { registrationNumber: 'EV12EVV', fuelType: 'ELECTRICITY', engineCapacity: 0 },
  };
  const resp = toUnifiedResponse('EV12EVV', dvlaResult, { available: false, data: null }, { data: null, error: null });
  assert.equal(resp.fuel_category, 'electric');
  assert.equal(resp.fuel_type, 'electricity');
});

test('toUnifiedResponse with null fuelType → fuel_category null', () => {
  const { toUnifiedResponse } = require('../src/services/vehicleCheckService');
  const dvlaResult = {
    available: true,
    data: { registrationNumber: 'ZZ99ZZZ', fuelType: null, engineCapacity: 0 },
  };
  const resp = toUnifiedResponse('ZZ99ZZZ', dvlaResult, { available: false, data: null }, { data: null, error: null });
  assert.equal(resp.fuel_type, null);
  assert.equal(resp.fuel_category, null);
});

test('mockVehicleFor includes fuel_type and fuel_category', () => {
  const { mockVehicleFor } = require('../src/routes/vehicles');
  const mock = mockVehicleFor('AB12CDE');
  assert.ok('fuel_type' in mock,    'mock must include fuel_type');
  assert.ok('fuel_category' in mock, 'mock must include fuel_category');
  // The mock's fuelType drives both derived fields; check consistency.
  const { deriveFuelFields: dff } = require('../src/utils/dvlaFuelCategory');
  const expected = dff(mock.fuelType);
  assert.equal(mock.fuel_type,     expected.fuel_type);
  assert.equal(mock.fuel_category, expected.fuel_category);
});

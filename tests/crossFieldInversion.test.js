'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateCrossFieldRelationships } = require('../src/utils/stationQuarantine');

const SILENT = { warn: () => {}, error: () => {}, log: () => {} };

test('ASDA Express fixture: super_unleaded < petrol → super quarantined as cross_field_inversion_super_lt_petrol', () => {
  // Real B92 ASDA Express row from the audit week.
  const station = {
    id: 'asda-b92',
    brand: 'Asda Express',
    postcode: 'B92 7AA',
    petrol_price: 175.9,
    e10_price: 170.9,
    super_unleaded_price: 173.9,
    diesel_price: 180.9,
  };
  const [out] = validateCrossFieldRelationships([station], { logger: SILENT });
  assert.equal(out.super_unleaded_price, null);
  assert.equal(out.super_unleaded_price_quarantined, true);
  assert.equal(out.super_unleaded_price_quarantine_reason, 'cross_field_inversion_super_lt_petrol');
  assert.equal(out.super_unleaded_price_quarantined_value, 173.9);
  // Other fields untouched.
  assert.equal(out.petrol_price, 175.9);
  assert.equal(out.diesel_price, 180.9);
});

test('petrol < e10 → petrol quarantined as cross_field_inversion_petrol_lt_e10', () => {
  const station = {
    id: 'st-p-lt-e10',
    brand: 'TestCo',
    postcode: 'CV4 1AA',
    petrol_price: 151.9,
    e10_price: 160.9,
    diesel_price: 170.9,
  };
  const [out] = validateCrossFieldRelationships([station], { logger: SILENT });
  assert.equal(out.petrol_price, null);
  assert.equal(out.petrol_price_quarantined, true);
  assert.equal(out.petrol_price_quarantine_reason, 'cross_field_inversion_petrol_lt_e10');
  assert.equal(out.petrol_price_quarantined_value, 151.9);
  assert.equal(out.e10_price, 160.9);
});

test('all sane prices → no changes, no quarantine flags set', () => {
  const station = {
    id: 'sane',
    brand: 'BP',
    postcode: 'SW1A 1AA',
    petrol_price: 152.9,
    e10_price: 148.9,
    super_unleaded_price: 165.9,
    diesel_price: 158.9,
    premium_diesel_price: 175.9,
  };
  const [out] = validateCrossFieldRelationships([station], { logger: SILENT });
  assert.equal(out.petrol_price, 152.9);
  assert.equal(out.e10_price, 148.9);
  assert.equal(out.super_unleaded_price, 165.9);
  assert.equal(out.diesel_price, 158.9);
  assert.equal(out.premium_diesel_price, 175.9);
  assert.equal(out.petrol_price_quarantined, undefined);
  assert.equal(out.super_unleaded_price_quarantined, undefined);
  assert.equal(out.premium_diesel_price_quarantined, undefined);
});

test('super_unleaded < e10 (with no petrol) → super quarantined as cross_field_inversion_super_lt_e10', () => {
  const station = {
    id: 'super-e10',
    brand: 'TestCo',
    e10_price: 170.9,
    super_unleaded_price: 165.9,
  };
  const [out] = validateCrossFieldRelationships([station], { logger: SILENT });
  assert.equal(out.super_unleaded_price, null);
  assert.equal(out.super_unleaded_price_quarantined, true);
  assert.equal(out.super_unleaded_price_quarantine_reason, 'cross_field_inversion_super_lt_e10');
});

test('premium_diesel < diesel → premium_diesel quarantined as cross_field_inversion_premium_lt_standard', () => {
  const station = {
    id: 'prem-d',
    brand: 'TestCo',
    diesel_price: 180.9,
    premium_diesel_price: 175.9,
  };
  const [out] = validateCrossFieldRelationships([station], { logger: SILENT });
  assert.equal(out.premium_diesel_price, null);
  assert.equal(out.premium_diesel_price_quarantined, true);
  assert.equal(out.premium_diesel_price_quarantine_reason, 'cross_field_inversion_premium_lt_standard');
  assert.equal(out.premium_diesel_price_quarantined_value, 175.9);
});

test('does not double-stamp a field already quarantined upstream', () => {
  const station = {
    id: 'already-q',
    brand: 'TestCo',
    petrol_price: 151.9,
    petrol_price_quarantined: true,
    petrol_price_quarantine_reason: 'stale_over_24h',
    e10_price: 160.9,
  };
  const [out] = validateCrossFieldRelationships([station], { logger: SILENT });
  // Reason preserved from upstream — not overwritten by cross-field stamp.
  assert.equal(out.petrol_price_quarantine_reason, 'stale_over_24h');
});

test('null/missing fields are skipped (no inversion can be claimed)', () => {
  const station = {
    id: 'sparse',
    brand: 'TestCo',
    petrol_price: 152.9,
    e10_price: null,
    super_unleaded_price: 150.9,
  };
  const [out] = validateCrossFieldRelationships([station], { logger: SILENT });
  // super < petrol triggers, but super < e10 cannot trigger (e10 is null).
  assert.equal(out.super_unleaded_price, null);
  assert.equal(out.super_unleaded_price_quarantine_reason, 'cross_field_inversion_super_lt_petrol');
});

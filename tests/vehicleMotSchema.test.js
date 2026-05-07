'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const vehicleCheckService = require('../src/services/vehicleCheckService');

test('mot_* fields always present even when MOT data missing', () => {
  const dvlaResult = { available: true, error: null, data: { registrationNumber: 'AB12CDE', make: 'FORD' } };
  const motResult = { available: false, error: 'not configured', data: null };
  const r = vehicleCheckService.toUnifiedResponse('AB12CDE', dvlaResult, motResult);
  assert.equal(r.mot_status, null);
  assert.equal(r.mot_expiry_date, null);
  assert.equal(r.mot_last_test_date, null);
  assert.equal(r.mot_last_test_result, null);
  assert.deepEqual(r.mot_advisories, []);
  assert.deepEqual(r.mot_defects, []);
  assert.equal(r.mot_test_count, 0);
  assert.equal(r.mot_odometer_at_last_test, null);
  assert.equal(r.mot_source, 'unavailable');
});

test('mot_status: "valid" when latest test expiryDate is in future', () => {
  const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const motResult = {
    available: true,
    data: [{
      motTests: [{
        completedDate: '2026-04-01',
        testResult: 'PASSED',
        expiryDate: future,
        odometerValue: 42150,
        odometerUnit: 'mi',
        defects: [
          { text: 'Tyre worn', type: 'ADVISORY', dangerous: false },
          { text: 'OSR brake pad worn', type: 'MINOR', dangerous: false },
        ],
      }],
    }],
  };
  const r = vehicleCheckService.toUnifiedResponse('AB12CDE', { available: true, data: {} }, motResult);
  assert.equal(r.mot_status, 'valid');
  assert.equal(r.mot_expiry_date, future);
  assert.equal(r.mot_last_test_result, 'PASSED');
  assert.deepEqual(r.mot_advisories, ['Tyre worn']);
  assert.deepEqual(r.mot_defects, ['OSR brake pad worn']);
  assert.equal(r.mot_test_count, 1);
  assert.deepEqual(r.mot_odometer_at_last_test, { value: 42150, unit: 'mi' });
  assert.equal(r.mot_source, 'dvsa');
});

test('mot_status: "expired" when latest test expiryDate is in past', () => {
  const past = '2024-01-01';
  const motResult = {
    available: true,
    data: [{
      motTests: [{
        completedDate: '2023-01-01',
        testResult: 'PASSED',
        expiryDate: past,
        defects: [],
      }],
    }],
  };
  const r = vehicleCheckService.toUnifiedResponse('AB12CDE', { available: true, data: {} }, motResult);
  assert.equal(r.mot_status, 'expired');
});

test('latest test picked when multiple tests in history', () => {
  const motResult = {
    available: true,
    data: [{
      motTests: [
        { completedDate: '2024-08-10', testResult: 'PASSED', expiryDate: '2025-08-09', defects: [] },
        { completedDate: '2025-08-15', testResult: 'PASSED', expiryDate: '2030-08-15', defects: [{ text: 'Latest advisory', type: 'ADVISORY' }] },
        { completedDate: '2023-08-10', testResult: 'FAILED', expiryDate: '2023-08-10', defects: [] },
      ],
    }],
  };
  const r = vehicleCheckService.toUnifiedResponse('AB12CDE', { available: true, data: {} }, motResult);
  assert.equal(r.mot_test_count, 3);
  assert.equal(r.mot_last_test_date, '2025-08-15');
  assert.deepEqual(r.mot_advisories, ['Latest advisory']);
});

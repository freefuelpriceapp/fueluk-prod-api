'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isFlagEnabled, hasCredentials, scheduleFuelFinder } = require('../../src/services/fuelFinder');

test('feature flag reads FEATURE_FUEL_FINDER', () => {
  const prior = process.env.FEATURE_FUEL_FINDER;
  process.env.FEATURE_FUEL_FINDER = 'true';
  assert.equal(isFlagEnabled(), true);
  process.env.FEATURE_FUEL_FINDER = 'false';
  assert.equal(isFlagEnabled(), false);
  delete process.env.FEATURE_FUEL_FINDER;
  assert.equal(isFlagEnabled(), false);
  if (prior !== undefined) process.env.FEATURE_FUEL_FINDER = prior;
});

test('hasCredentials requires both id and secret', () => {
  const priorId = process.env.FUEL_FINDER_CLIENT_ID;
  const priorSecret = process.env.FUEL_FINDER_CLIENT_SECRET;
  delete process.env.FUEL_FINDER_CLIENT_ID;
  delete process.env.FUEL_FINDER_CLIENT_SECRET;
  assert.equal(hasCredentials(), false);
  process.env.FUEL_FINDER_CLIENT_ID = 'x';
  assert.equal(hasCredentials(), false);
  process.env.FUEL_FINDER_CLIENT_SECRET = 'y';
  assert.equal(hasCredentials(), true);
  if (priorId !== undefined) process.env.FUEL_FINDER_CLIENT_ID = priorId; else delete process.env.FUEL_FINDER_CLIENT_ID;
  if (priorSecret !== undefined) process.env.FUEL_FINDER_CLIENT_SECRET = priorSecret; else delete process.env.FUEL_FINDER_CLIENT_SECRET;
});

test('scheduleFuelFinder is a no-op when disabled', () => {
  const prior = process.env.FEATURE_FUEL_FINDER;
  process.env.FEATURE_FUEL_FINDER = 'false';
  const result = scheduleFuelFinder();
  assert.equal(result.enabled, false);
  if (prior !== undefined) process.env.FEATURE_FUEL_FINDER = prior; else delete process.env.FEATURE_FUEL_FINDER;
});

test('scheduleFuelFinder refuses without credentials even if flag set', () => {
  const priorFlag = process.env.FEATURE_FUEL_FINDER;
  const priorId = process.env.FUEL_FINDER_CLIENT_ID;
  const priorSecret = process.env.FUEL_FINDER_CLIENT_SECRET;
  process.env.FEATURE_FUEL_FINDER = 'true';
  delete process.env.FUEL_FINDER_CLIENT_ID;
  delete process.env.FUEL_FINDER_CLIENT_SECRET;
  const result = scheduleFuelFinder();
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'missing_credentials');
  if (priorFlag !== undefined) process.env.FEATURE_FUEL_FINDER = priorFlag; else delete process.env.FEATURE_FUEL_FINDER;
  if (priorId !== undefined) process.env.FUEL_FINDER_CLIENT_ID = priorId;
  if (priorSecret !== undefined) process.env.FUEL_FINDER_CLIENT_SECRET = priorSecret;
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseReg, estimateMpg, yearFromAgeIdentifier } = require('../src/routes/vehicles');

test('normaliseReg strips spaces and uppercases', () => {
  assert.equal(normaliseReg('ab12 cde'), 'AB12CDE');
  assert.equal(normaliseReg('  AB12CDE '), 'AB12CDE');
});

test('normaliseReg rejects obvious garbage', () => {
  assert.equal(normaliseReg(''), null);
  assert.equal(normaliseReg('!!!'), null);
  assert.equal(normaliseReg(null), null);
  assert.equal(normaliseReg(undefined), null);
});

test('yearFromAgeIdentifier handles both period formats', () => {
  assert.equal(yearFromAgeIdentifier('24'), 2024); // Mar–Aug 2024
  assert.equal(yearFromAgeIdentifier('74'), 2024); // Sep 2024–Feb 2025
  assert.equal(yearFromAgeIdentifier('12'), 2012);
  assert.equal(yearFromAgeIdentifier('62'), 2012);
});

test('estimateMpg gives higher mpg to small-diesel than big-petrol', () => {
  const smallDiesel = estimateMpg('DIESEL', 1500);
  const bigPetrol = estimateMpg('PETROL', 2500);
  assert.ok(smallDiesel > bigPetrol);
});

test('estimateMpg returns 0 for pure electric (no ICE mpg)', () => {
  assert.equal(estimateMpg('ELECTRIC', 0), 0);
});

test('estimateMpg treats hybrid as ~60 mpg', () => {
  assert.equal(estimateMpg('HYBRID ELECTRIC', 1800), 60);
});

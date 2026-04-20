'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBrandKey,
  canonicalBrandName,
  normalizedKeysForBrandFilter,
} = require('../src/utils/brandNormalizer');

test('normalizeBrandKey strips punctuation and case', () => {
  assert.equal(normalizeBrandKey('Sainsburys'), normalizeBrandKey("SAINSBURY'S"));
  assert.equal(normalizeBrandKey('bp'), 'BP');
  assert.equal(normalizeBrandKey(' Tesco-Express. '), 'TESCOEXPRESS');
});

test('normalizeBrandKey maps alias groups onto the canonical key', () => {
  assert.equal(normalizeBrandKey('Nicholl'), normalizeBrandKey('NICHOLLS'));
  assert.equal(
    normalizeBrandKey('Highland Fuels'),
    normalizeBrandKey('Highland fuels Ltd'),
  );
});

test('normalizeBrandKey returns empty string for null/empty input', () => {
  assert.equal(normalizeBrandKey(null), '');
  assert.equal(normalizeBrandKey(''), '');
  assert.equal(normalizeBrandKey('   '), '');
});

test('canonicalBrandName returns alias canonical for known variants', () => {
  assert.equal(canonicalBrandName('Nicholl'), 'Nicholls');
  assert.equal(canonicalBrandName('NICHOLLS'), 'Nicholls');
  assert.equal(canonicalBrandName('Highland fuels Ltd'), 'Highland Fuels');
});

test('canonicalBrandName preserves trimmed brand for unknown brands', () => {
  assert.equal(canonicalBrandName(' BP '), 'BP');
  assert.equal(canonicalBrandName("SAINSBURY'S"), "SAINSBURY'S");
});

test('normalizedKeysForBrandFilter expands alias groups', () => {
  const keys = normalizedKeysForBrandFilter('Nicholls');
  assert.ok(keys.includes('NICHOLL'));
  assert.ok(keys.includes('NICHOLLS'));
});

test('normalizedKeysForBrandFilter returns single key for unknown brands', () => {
  const keys = normalizedKeysForBrandFilter("Sainsbury's");
  assert.deepEqual(keys, ['SAINSBURYS']);
});

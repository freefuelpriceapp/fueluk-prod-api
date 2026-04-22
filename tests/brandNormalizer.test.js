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

test('normalizeBrandKey collapses MFG variants onto Esso', () => {
  const essoKey = normalizeBrandKey('Esso');
  assert.equal(normalizeBrandKey('Motor Fuel Group'), essoKey);
  assert.equal(normalizeBrandKey('MFG'), essoKey);
  assert.equal(normalizeBrandKey('MOTOR FUEL GROUP'), essoKey);
});

test('normalizeBrandKey collapses EG Group variants onto Applegreen', () => {
  const applegreenKey = normalizeBrandKey('Applegreen');
  assert.equal(normalizeBrandKey('EG On The Move'), applegreenKey);
  assert.equal(normalizeBrandKey('Eg On The Move'), applegreenKey);
  assert.equal(normalizeBrandKey('EG ON THE MOVE'), applegreenKey);
  assert.equal(normalizeBrandKey('EG Group'), applegreenKey);
  assert.equal(normalizeBrandKey('EG GROUP'), applegreenKey);
  assert.equal(normalizeBrandKey('EG'), applegreenKey);
  assert.equal(normalizeBrandKey('Euro Garages'), applegreenKey);
  assert.equal(normalizeBrandKey('EURO GARAGES'), applegreenKey);
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

test('canonicalBrandName title-cases well-known brand casings', () => {
  assert.equal(canonicalBrandName('ESSO'), 'Esso');
  assert.equal(canonicalBrandName('Esso'), 'Esso');
  assert.equal(canonicalBrandName('esso'), 'Esso');
  assert.equal(canonicalBrandName('SHELL'), 'Shell');
  assert.equal(canonicalBrandName('shell'), 'Shell');
  assert.equal(canonicalBrandName('TEXACO'), 'Texaco');
  assert.equal(canonicalBrandName('TESCO'), 'Tesco');
  assert.equal(canonicalBrandName('ASDA'), 'Asda');
  assert.equal(canonicalBrandName('MORRISONS'), 'Morrisons');
});

test('canonicalBrandName maps MFG / Motor Fuel Group to Esso display brand', () => {
  assert.equal(canonicalBrandName('Motor Fuel Group'), 'Esso');
  assert.equal(canonicalBrandName('MOTOR FUEL GROUP'), 'Esso');
  assert.equal(canonicalBrandName('MFG'), 'Esso');
  assert.equal(canonicalBrandName('MFG Expressway'), 'Esso');
});

test('canonicalBrandName maps EG Group / Euro Garages variants to Applegreen', () => {
  assert.equal(canonicalBrandName('EG On The Move'), 'Applegreen');
  assert.equal(canonicalBrandName('Eg On The Move'), 'Applegreen');
  assert.equal(canonicalBrandName('EG ON THE MOVE'), 'Applegreen');
  assert.equal(canonicalBrandName('EG Group'), 'Applegreen');
  assert.equal(canonicalBrandName('EG GROUP'), 'Applegreen');
  assert.equal(canonicalBrandName('EG'), 'Applegreen');
  assert.equal(canonicalBrandName('Euro Garages'), 'Applegreen');
  assert.equal(canonicalBrandName('EURO GARAGES'), 'Applegreen');
});

test('canonicalBrandName preserves smaller independents as-is', () => {
  // Certas, Rontec, Park Garage Group have no consumer-brand override
  assert.equal(canonicalBrandName('Certas Energy'), 'Certas Energy');
  assert.equal(canonicalBrandName('CERTAS ENERGY'), 'Certas Energy');
  assert.equal(canonicalBrandName('Rontec'), 'Rontec');
  assert.equal(canonicalBrandName('RONTEC'), 'Rontec');
  assert.equal(canonicalBrandName('Park Garage Group'), 'Park Garage Group');
});

test('canonicalBrandName maps Sainsbury variants to apostrophe form', () => {
  assert.equal(canonicalBrandName("SAINSBURY'S"), "Sainsbury's");
  assert.equal(canonicalBrandName('Sainsburys'), "Sainsbury's");
  assert.equal(canonicalBrandName('SAINSBURYS'), "Sainsbury's");
});

test('canonicalBrandName preserves BP as uppercase acronym', () => {
  assert.equal(canonicalBrandName(' BP '), 'BP');
  assert.equal(canonicalBrandName('bp'), 'BP');
});

test('canonicalBrandName title-cases unknown brands instead of SHOUTING', () => {
  assert.equal(canonicalBrandName('LITTLE CHEF FUEL'), 'Little Chef Fuel');
  assert.equal(canonicalBrandName('some unknown brand'), 'Some Unknown Brand');
});

test('canonicalBrandName handles null/empty', () => {
  assert.equal(canonicalBrandName(null), null);
  assert.equal(canonicalBrandName(''), '');
});

test('normalizedKeysForBrandFilter expands alias groups', () => {
  const keys = normalizedKeysForBrandFilter('Nicholls');
  assert.ok(keys.includes('NICHOLL'));
  assert.ok(keys.includes('NICHOLLS'));
});

test('normalizedKeysForBrandFilter matches Esso + MFG variants together', () => {
  const keys = normalizedKeysForBrandFilter('Esso');
  assert.ok(keys.includes('ESSO'));
  assert.ok(keys.includes('MOTORFUELGROUP'));
  assert.ok(keys.includes('MFG'));
  // Filtering by "Motor Fuel Group" also covers the same group.
  const viaOperator = normalizedKeysForBrandFilter('Motor Fuel Group');
  assert.ok(viaOperator.includes('ESSO'));
});

test('normalizedKeysForBrandFilter matches Applegreen + EG variants together', () => {
  const keys = normalizedKeysForBrandFilter('Applegreen');
  assert.ok(keys.includes('APPLEGREEN'));
  assert.ok(keys.includes('EG'));
  assert.ok(keys.includes('EGGROUP'));
  assert.ok(keys.includes('EGONTHEMOVE'));
  assert.ok(keys.includes('EUROGARAGES'));
  // Filtering by the operator name covers the same group.
  const viaOperator = normalizedKeysForBrandFilter('EG On The Move');
  assert.ok(viaOperator.includes('APPLEGREEN'));
});

test('normalizedKeysForBrandFilter returns expanded keys for Sainsbury', () => {
  const keys = normalizedKeysForBrandFilter("Sainsbury's");
  assert.ok(keys.includes('SAINSBURYS'));
});

test('normalizedKeysForBrandFilter tolerates null/empty', () => {
  assert.deepEqual(normalizedKeysForBrandFilter(''), []);
  assert.deepEqual(normalizedKeysForBrandFilter(null), []);
});

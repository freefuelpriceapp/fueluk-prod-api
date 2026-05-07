'use strict';

/**
 * brandingB07.test.js — B-07
 *
 * Asserts that the old "FreeFuelPrice UK" / "FreeFuelPrice Premium"
 * strings have been replaced with "FuelUK" / "FuelUK Premium" across
 * all relevant source files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readFile(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('requirePremium.js: no "FreeFuelPrice Premium" string', () => {
  const src = readFile('src/middleware/requirePremium.js');
  assert.ok(
    !src.includes('FreeFuelPrice Premium'),
    'requirePremium.js must not contain "FreeFuelPrice Premium"',
  );
});

test('requirePremium.js: upgrade message says "FuelUK Premium"', () => {
  const src = readFile('src/middleware/requirePremium.js');
  assert.ok(
    src.includes('FuelUK Premium'),
    'requirePremium.js must say "FuelUK Premium" in the upgrade message',
  );
});

test('pages.js: no bare "FreeFuelPrice UK" branding string', () => {
  const src = readFile('src/routes/pages.js');
  // The legal entity name "Free Fuel Price App Ltd" is kept (legal requirement).
  // We check that the standalone app-name reference "FreeFuelPrice UK" is gone.
  assert.ok(
    !src.includes('FreeFuelPrice UK'),
    'pages.js must not contain "FreeFuelPrice UK" (app display name)',
  );
});

test('pages.js: company name section mentions FuelUK', () => {
  const src = readFile('src/routes/pages.js');
  assert.ok(
    src.includes('FuelUK'),
    'pages.js must reference the FuelUK brand name',
  );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatAlertNotification } = require('../src/utils/alertNotification');

test('formatAlertNotification formats pence prices without dividing by 100', () => {
  const msg = formatAlertNotification({
    fuel_type: 'petrol',
    station_brand: 'TESCO',
    station_name: 'Tesco Cambridge',
    current_price: 150.9,
    threshold_pence: 155,
  });
  assert.equal(msg.title, 'Petrol price alert');
  assert.equal(msg.body, 'TESCO is now 150.9p/L — below your 155.0p target.');
});

test('formatAlertNotification falls back to station_name when brand missing', () => {
  const msg = formatAlertNotification({
    fuel_type: 'diesel',
    station_brand: null,
    station_name: 'Independent Garage',
    current_price: 162.3,
    threshold_pence: 165,
  });
  assert.match(msg.body, /^Independent Garage is now 162\.3p\/L/);
});

test('title has no emoji (avoids devices that cannot render it)', () => {
  const msg = formatAlertNotification({
    fuel_type: 'e10',
    station_brand: 'BP',
    station_name: 'BP',
    current_price: 145,
    threshold_pence: 150,
  });
  // ASCII-only assertion: the title must contain no non-ASCII codepoints.
  for (const ch of msg.title) {
    assert.ok(ch.charCodeAt(0) < 128, `unexpected non-ASCII char in title: ${ch}`);
  }
});

test('handles numeric-string prices (pg DECIMAL returns strings)', () => {
  const msg = formatAlertNotification({
    fuel_type: 'petrol',
    station_brand: 'SAINSBURY',
    station_name: 'Sainsbury',
    current_price: '149.7',
    threshold_pence: '150',
  });
  assert.equal(msg.body, 'SAINSBURY is now 149.7p/L — below your 150.0p target.');
});

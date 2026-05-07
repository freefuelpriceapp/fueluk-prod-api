'use strict';

/**
 * alertNotification.js
 * Pure helpers for building push-notification title/body for a price alert.
 * Isolated from alertJob so it can be unit-tested without pulling in
 * node-cron and the DB pool.
 *
 * NOTE: price fields are stored in the DB already in pence (e.g. 150.9).
 * Do NOT divide by 100 when formatting — doing so caused notifications to
 * display "1.5p/L" instead of "150.9p/L".
 */

const FUEL_LABELS = {
  unleaded: 'Unleaded',
  super_unleaded: 'Super unleaded',
  diesel: 'Diesel',
  premium_diesel: 'Premium diesel',
  petrol: 'Petrol',
  e10: 'E10',
  e5: 'E5',
};

function formatAlertNotification(a) {
  const fuelLabel =
    FUEL_LABELS[a.fuel_type] ||
    a.fuel_type.charAt(0).toUpperCase() + a.fuel_type.slice(1);
  return {
    title: `${fuelLabel} price alert`,
    body: `${a.station_brand || a.station_name} is now ${Number(a.current_price).toFixed(1)}p/L — below your ${Number(a.threshold_pence).toFixed(1)}p target.`,
  };
}

module.exports = { formatAlertNotification };

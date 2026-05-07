'use strict';

/**
 * costcoBackfill.js — Phase 1A (Costco ingestion repair)
 *
 * Costco does NOT publish a standalone CMA brand-feed JSON (they are not on
 * the interim scheme's brand feed list). Their prices are published exclusively
 * via the UK Government Fuel Finder API (Motor Fuel Price (Open Data)
 * Regulations 2025). This means prices flow through fuelFinder/priceSync.js,
 * NOT govFuelData.js.
 *
 * Live observations:
 *   - Costco Birmingham B7 5SA: e10_price=147.9 ✓ (Fuel Finder matched)
 *   - Costco Watford WD25 8JS: e10_price=null   ✗ (not yet matched / stale)
 *   - petrol_price=null, super_unleaded_price=null → CORRECT: Costco sells
 *     E10 + diesel only; they do NOT sell E5 (super/premium unleaded).
 *
 * This service provides:
 *   1. clearCostcoUnsupportedFuelPrices() — sets petrol_price and
 *      super_unleaded_price to NULL for all Costco rows where those fields
 *      were erroneously populated by an older CMA brand-feed entry. Idempotent.
 *
 *   2. getCostcoNullE10Count() — diagnostic helper: returns the count of Costco
 *      stations whose e10_price is currently NULL so operators know how many
 *      stations still need a Fuel Finder price sync.
 *
 *   3. getCostcoE10Coverage() — returns total, non-null e10_price count, and
 *      null count for all Costco stations. Used by the test suite.
 */

const { getPool } = require('../config/db');

/**
 * Costco only sells E10 and diesel (B7_STANDARD).
 * petrol_price (E5/super-95) and super_unleaded_price (E5/RON98) are
 * structurally absent from all Costco forecourts. Clear any legacy values.
 */
async function clearCostcoUnsupportedFuelPrices({ pool: poolOverride } = {}) {
  const pool = poolOverride || getPool();
  const res = await pool.query(`
    UPDATE stations
       SET petrol_price        = NULL,
           petrol_source       = NULL,
           petrol_updated_at   = NULL,
           super_unleaded_price        = NULL,
           super_unleaded_source       = NULL,
           super_unleaded_updated_at   = NULL,
           premium_diesel_price        = NULL,
           premium_diesel_source       = NULL,
           premium_diesel_updated_at   = NULL
     WHERE brand ILIKE '%costco%'
       AND (
         petrol_price IS NOT NULL
         OR super_unleaded_price IS NOT NULL
         OR premium_diesel_price IS NOT NULL
       )
  `);
  return { cleared: res.rowCount };
}

/**
 * Returns the count of Costco stations whose e10_price is NULL.
 * A non-zero result means those stations have not yet received a Fuel Finder
 * price update and need a priceSync run.
 */
async function getCostcoNullE10Count({ pool: poolOverride } = {}) {
  const pool = poolOverride || getPool();
  const res = await pool.query(`
    SELECT COUNT(*)::int AS null_count
    FROM stations
    WHERE brand ILIKE '%costco%'
      AND e10_price IS NULL
  `);
  return (res.rows[0] || {}).null_count || 0;
}

/**
 * Returns e10_price coverage across all known Costco stations.
 * Used by costcoIngestionTest.js to assert ≥30 of ~33 stations are populated.
 */
async function getCostcoE10Coverage({ pool: poolOverride } = {}) {
  const pool = poolOverride || getPool();
  const res = await pool.query(`
    SELECT
      COUNT(*)::int                                       AS total,
      COUNT(*) FILTER (WHERE e10_price IS NOT NULL)::int AS with_e10,
      COUNT(*) FILTER (WHERE e10_price IS NULL)::int     AS null_e10
    FROM stations
    WHERE brand ILIKE '%costco%'
  `);
  return res.rows[0] || { total: 0, with_e10: 0, null_e10: 0 };
}

module.exports = {
  clearCostcoUnsupportedFuelPrices,
  getCostcoNullE10Count,
  getCostcoE10Coverage,
};

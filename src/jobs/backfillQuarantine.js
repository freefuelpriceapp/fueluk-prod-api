'use strict';

const { getPool } = require('../config/db');

/**
 * Wave A backfill — one-shot pass that:
 *
 *  1. Backfills any NULL `*_updated_at` field with `last_updated` so the
 *     per-field freshness gate has a baseline timestamp instead of treating
 *     every legacy row as "unknown age" on first deploy.
 *
 *  2. For every Fuel Finder station whose `fuel_types` array is populated,
 *     nulls out price columns for fuel types the station does NOT stock.
 *     This is the explicit fix for stuck-price cases like Apple Green
 *     B10 0AE — a 140p super unleaded reading that the station's own feed
 *     reports as "unavailable" gets purged here regardless of which feed
 *     wrote it. Fuel Finder rows are left untouched (we trust ourselves).
 *
 * Designed to be idempotent: safe to run multiple times. Returns a summary
 * object so callers (the admin endpoint, server-boot wiring) can log results.
 */

const FUEL_TYPE_CLEAR_MAP = [
  { code: 'E10', priceCol: 'e10_price', sourceCol: 'e10_source', tsCol: 'e10_updated_at' },
  { code: 'E5', priceCol: 'super_unleaded_price', sourceCol: 'super_unleaded_source', tsCol: 'super_unleaded_updated_at' },
  { code: 'B7_STANDARD', priceCol: 'diesel_price', sourceCol: 'diesel_source', tsCol: 'diesel_updated_at' },
  { code: 'B7_PREMIUM', priceCol: 'premium_diesel_price', sourceCol: 'premium_diesel_source', tsCol: 'premium_diesel_updated_at' },
];

async function backfillUpdatedAtFromLastUpdated(pool) {
  let total = 0;
  for (const f of FUEL_TYPE_CLEAR_MAP) {
    const res = await pool.query(
      `UPDATE stations
          SET ${f.tsCol} = last_updated
        WHERE ${f.priceCol} IS NOT NULL
          AND ${f.tsCol} IS NULL
          AND last_updated IS NOT NULL`
    );
    total += res.rowCount || 0;
  }
  // Petrol_price (E5 in CMA terms, RON95 standard) has no fuel_finder
  // counterpart in FUEL_TYPE_CLEAR_MAP — handle it explicitly.
  const r = await pool.query(
    `UPDATE stations
        SET petrol_updated_at = last_updated
      WHERE petrol_price IS NOT NULL
        AND petrol_updated_at IS NULL
        AND last_updated IS NOT NULL`
  );
  total += r.rowCount || 0;
  return total;
}

async function clearMissingFuelTypePricesAcrossAll(pool) {
  const res = await pool.query(
    `SELECT id, fuel_finder_node_id, fuel_types
       FROM stations
      WHERE fuel_finder_node_id IS NOT NULL
        AND fuel_types IS NOT NULL`
  );
  let stationsTouched = 0;
  let fieldsCleared = 0;
  for (const row of res.rows) {
    const list = Array.isArray(row.fuel_types) ? row.fuel_types : null;
    if (!list || list.length === 0) continue;
    const stocked = new Set(list.map((c) => String(c).toUpperCase()));
    const clears = FUEL_TYPE_CLEAR_MAP.filter((f) => !stocked.has(f.code));
    if (!clears.length) continue;
    const setParts = [];
    for (const f of clears) {
      setParts.push(`${f.priceCol} = NULL`);
      setParts.push(`${f.sourceCol} = NULL`);
      setParts.push(`${f.tsCol} = NULL`);
    }
    const where = clears
      .map((f) => `(${f.priceCol} IS NOT NULL AND COALESCE(${f.sourceCol}, '') <> 'fuel_finder')`)
      .join(' OR ');
    const upd = await pool.query(
      `UPDATE stations
          SET ${setParts.join(', ')}
        WHERE id = $1
          AND (${where})`,
      [row.id]
    );
    if (upd.rowCount > 0) {
      stationsTouched += 1;
      fieldsCleared += clears.length;
    }
  }
  return { stationsTouched, fieldsCleared };
}

async function runBackfillQuarantine({ pool = getPool() } = {}) {
  const startedAt = new Date();
  const updatedAtRows = await backfillUpdatedAtFromLastUpdated(pool);
  const cleared = await clearMissingFuelTypePricesAcrossAll(pool);
  const finishedAt = new Date();
  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    updated_at_backfilled: updatedAtRows,
    stations_with_cleared_fields: cleared.stationsTouched,
    fields_cleared: cleared.fieldsCleared,
  };
  console.log('[BackfillQuarantine] complete:', JSON.stringify(summary));
  return summary;
}

module.exports = {
  runBackfillQuarantine,
  backfillUpdatedAtFromLastUpdated,
  clearMissingFuelTypePricesAcrossAll,
  FUEL_TYPE_CLEAR_MAP,
};

'use strict';
const { getPool } = require('../config/db');
const { clearCache } = require('../middleware/responseCache');

/**
 * ingestService.js — Sprint 2 + Sprint 4 update
 *
 * 2026-06-15 update: Fuel Finder is now the single source of truth for
 * station and price data. The old brand-direct govFuelData scraper and the
 * non-gov Applegreen HTML scraper have been retired — they produced
 * duplicate rows in the `stations` table (gcqd-* alongside ff-*) and stamped
 * `last_updated = NOW()` on dead rows, which is what surfaced the Birmingham
 * 135.8p Applegreen ghosts on /stations/cheapest.
 *
 * runFullIngest() now only writes price_history snapshots from whatever
 * Fuel Finder has already populated into the stations table. Fuel Finder's
 * own scheduler (scheduleFuelFinder in server.js) handles the actual price
 * ingestion every hour.
 */

/**
 * snapshotPriceHistory
 * After each sync, insert one price_history row per station per fuel type
 * where that fuel has a price. Uses INSERT ... ON CONFLICT DO NOTHING to
 * avoid duplicates within the same hour bucket.
 * Schema: (station_id, fuel_type, price_pence, recorded_at)
 */
async function snapshotPriceHistory() {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO price_history (station_id, fuel_type, price_pence, source, recorded_at)
    SELECT s.id, v.fuel_type, v.price_pence, v.source, date_trunc('hour', NOW()) AS recorded_at
    FROM stations s
    CROSS JOIN LATERAL (
      VALUES
        ('petrol',         s.petrol_price,         COALESCE(s.petrol_source,         'gov')),
        ('diesel',         s.diesel_price,         COALESCE(s.diesel_source,         'gov')),
        ('e10',            s.e10_price,            COALESCE(s.e10_source,            'gov')),
        ('super_unleaded', s.super_unleaded_price, COALESCE(s.super_unleaded_source, 'fuel_finder')),
        ('premium_diesel', s.premium_diesel_price, COALESCE(s.premium_diesel_source, 'fuel_finder'))
    ) AS v(fuel_type, price_pence, source)
    WHERE v.price_pence IS NOT NULL
    ON CONFLICT (station_id, fuel_type, recorded_at) DO NOTHING
  `);
  return result.rowCount;
}

/**
 * runFullIngest
 * Complete ingest pipeline: sync stations then snapshot prices.
 * Returns a summary object for logging / admin endpoint response.
 */
async function runFullIngest() {
  const startedAt = new Date();
  console.log(`[IngestService] Starting price_history snapshot at ${startedAt.toISOString()}`);

  const errors = [];
  let snapshotRows = 0;

  try {
    snapshotRows = await snapshotPriceHistory();
    console.log(`[IngestService] snapshotPriceHistory complete — ${snapshotRows} rows written`);
  } catch (err) {
    console.error('[IngestService] snapshotPriceHistory failed:', err.message);
    errors.push({ phase: 'snapshot', message: err.message });
  }

  const finishedAt = new Date();
  const durationMs = finishedAt - startedAt;

  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    stationsUpserted: 0, // retired — Fuel Finder owns ingestion
    historyRowsWritten: snapshotRows,
    stationsPatched: 0,  // retired — non-gov scraper killed 2026-06-15
    errors,
  };

  // Invalidate the response cache only if we actually wrote new history rows.
  if (snapshotRows > 0) {
    try {
      clearCache();
      console.log('[IngestService] Response cache cleared post-snapshot');
    } catch (err) {
      console.error('[IngestService] clearCache failed:', err.message);
    }
  }

  console.log('[IngestService] Snapshot run complete:', JSON.stringify(summary));
  return summary;
}

module.exports = { runFullIngest, snapshotPriceHistory };

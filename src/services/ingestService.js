'use strict';
const { syncFuelData } = require('./govFuelData');
const { getPool } = require('../config/db');
const { fillMissingPrices } = require('./nonGovFuelData');
const { clearCache } = require('../middleware/responseCache');

/**
 * ingestService.js — Sprint 2 + Sprint 4 update
 * Orchestrates the full ingest cycle:
 *   1. Pull latest prices from all brand endpoints (govFuelData)
 *   2. Snapshot changed prices into price_history (fuel_type/price_pence rows)
 *
 * Called by ingestRunner (cron) and optionally by an admin trigger endpoint.
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
  console.log(`[IngestService] Starting full ingest at ${startedAt.toISOString()}`);

  let syncResult = { totalUpserted: 0, errors: [] };
  let snapshotRows = 0;

  try {
    syncResult = await syncFuelData();
    console.log(`[IngestService] syncFuelData complete — upserted ${syncResult.totalUpserted} stations`);
  } catch (err) {
    console.error('[IngestService] syncFuelData failed:', err.message);
    syncResult.errors.push({ phase: 'sync', message: err.message });
  }

    // Step 1b: Fill missing prices from non-gov sources (e.g. PetrolMap scraping)
  let fillResult = { filled: 0 };
  try {
    fillResult = await fillMissingPrices();
    console.log(`[IngestService] fillMissingPrices complete – ${fillResult.filled} stations patched`);
  } catch (err) {
    console.error('[IngestService] fillMissingPrices failed:', err.message);
    syncResult.errors.push({ phase: 'fillMissing', message: err.message });
  }

  try {
    snapshotRows = await snapshotPriceHistory();
    console.log(`[IngestService] snapshotPriceHistory complete — ${snapshotRows} rows written`);
  } catch (err) {
    console.error('[IngestService] snapshotPriceHistory failed:', err.message);
    syncResult.errors.push({ phase: 'snapshot', message: err.message });
  }

  const finishedAt = new Date();
  const durationMs = finishedAt - startedAt;

  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    stationsUpserted: syncResult.totalUpserted,
    historyRowsWritten: snapshotRows,
        stationsPatched: fillResult.filled,
    errors: syncResult.errors,
  };

  // Invalidate the response cache so users see the fresh prices immediately.
  // Only clear when at least one upstream step succeeded; a total-failure run
  // would otherwise evict a warm cache for no benefit.
  if (syncResult.totalUpserted > 0 || fillResult.filled > 0 || snapshotRows > 0) {
    try {
      clearCache();
      console.log('[IngestService] Response cache cleared post-ingest');
    } catch (err) {
      console.error('[IngestService] clearCache failed:', err.message);
    }
  }

  console.log('[IngestService] Ingest complete:', JSON.stringify(summary));
  return summary;
}

module.exports = { runFullIngest, snapshotPriceHistory };

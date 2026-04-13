'use strict';
const { syncFuelData } = require('./govFuelData');
const { getPool } = require('../config/db');

/**
 * ingestService.js — Sprint 2
 * Orchestrates the full ingest cycle:
 *   1. Pull latest prices from all brand endpoints (govFuelData)
 *   2. Snapshot changed prices into price_history for trend data
 *
 * Called by ingestRunner (cron) and optionally by an admin trigger endpoint.
 */

/**
 * snapshotPriceHistory
 * After each sync, insert a price_history row for every station where
 * any price differs from the last recorded snapshot.
 * Uses INSERT ... ON CONFLICT DO NOTHING to avoid duplicates within
 * the same hour (rounded bucket).
 */
async function snapshotPriceHistory() {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO price_history (station_id, petrol_price, diesel_price, e10_price, recorded_at)
    SELECT
      s.id,
      s.petrol_price,
      s.diesel_price,
      s.e10_price,
      date_trunc('hour', NOW()) AS recorded_at
    FROM stations s
    WHERE s.petrol_price IS NOT NULL
      OR s.diesel_price IS NOT NULL
      OR s.e10_price IS NOT NULL
    ON CONFLICT (station_id, recorded_at) DO UPDATE
      SET petrol_price = EXCLUDED.petrol_price,
          diesel_price = EXCLUDED.diesel_price,
          e10_price    = EXCLUDED.e10_price
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
    errors: syncResult.errors,
  };

  console.log('[IngestService] Ingest complete:', JSON.stringify(summary));
  return summary;
}

module.exports = { runFullIngest, snapshotPriceHistory };

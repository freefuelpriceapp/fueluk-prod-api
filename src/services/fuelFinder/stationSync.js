'use strict';
const { getPool } = require('../../config/db');
const { stationToRow } = require('./mapping');

/**
 * Pulls every station from the Fuel Finder API (batches of 500) and
 * upserts them into the `stations` table, keyed by `fuel_finder_node_id`.
 *
 * Writes only metadata / identity columns — prices are updated separately
 * by priceSync.js on a much tighter schedule.
 */

const BATCH_SIZE = 500;
const MAX_BATCHES = 100; // hard ceiling: 50k stations — feed is ~8.5k
const MAX_CONSECUTIVE_ERRORS = 3;

async function upsertStation(pool, row) {
  await pool.query(
    `INSERT INTO stations (
        id, fuel_finder_node_id, brand, name, address, postcode,
        lat, lng,
        is_motorway, is_supermarket, temporary_closure, permanent_closure,
        opening_hours, amenities, fuel_types,
        last_updated
     ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8,
        $9, $10, $11, $12,
        $13, $14, $15,
        NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
        fuel_finder_node_id = EXCLUDED.fuel_finder_node_id,
        brand = EXCLUDED.brand,
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        postcode = EXCLUDED.postcode,
        lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        is_motorway = EXCLUDED.is_motorway,
        is_supermarket = EXCLUDED.is_supermarket,
        temporary_closure = EXCLUDED.temporary_closure,
        permanent_closure = EXCLUDED.permanent_closure,
        opening_hours = EXCLUDED.opening_hours,
        amenities = EXCLUDED.amenities,
        fuel_types = EXCLUDED.fuel_types,
        last_updated = NOW()`,
    [
      row.id,
      row.fuel_finder_node_id,
      row.brand,
      row.name,
      row.address,
      row.postcode,
      row.lat,
      row.lng,
      row.is_motorway,
      row.is_supermarket,
      row.temporary_closure,
      row.permanent_closure,
      row.opening_hours ? JSON.stringify(row.opening_hours) : null,
      row.amenities ? JSON.stringify(row.amenities) : null,
      row.fuel_types ? JSON.stringify(row.fuel_types) : null,
    ]
  );
}

async function recordSyncState(pool) {
  await pool.query(
    `UPDATE fuel_finder_sync_state
       SET last_station_sync_at = NOW(), updated_at = NOW()
     WHERE id = 1`
  );
}

/**
 * syncStations — full station crawl.
 * @param {{ apiClient: object, pool?: object }} deps
 * @returns {Promise<{batches: number, stationsSeen: number, stationsUpserted: number, errors: Array}>}
 */
async function syncStations({ apiClient, pool = getPool() }) {
  if (!apiClient) throw new Error('syncStations requires apiClient');
  console.log('[FuelFinder] Starting station sync...');

  let batchNumber = 1;
  let stationsSeen = 0;
  let stationsUpserted = 0;
  const errors = [];
  let consecutiveErrors = 0;

  while (batchNumber <= MAX_BATCHES) {
    let batch;
    try {
      batch = await apiClient.getStationsBatch(batchNumber);
    } catch (err) {
      console.error(`[FuelFinder] Station batch ${batchNumber} failed:`, err.message);
      errors.push({ batch: batchNumber, message: err.message });
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[FuelFinder] Aborting station sync after ${consecutiveErrors} consecutive batch failures`);
        break;
      }
      batchNumber++;
      continue;
    }

    consecutiveErrors = 0;
    if (!batch || batch.length === 0) break;
    stationsSeen += batch.length;

    for (const s of batch) {
      const row = stationToRow(s);
      if (!row) continue;
      try {
        await upsertStation(pool, row);
        stationsUpserted++;
      } catch (err) {
        if (errors.length < 5) {
          console.error(`[FuelFinder] Upsert failed for ${s.node_id}:`, err.message);
        }
        errors.push({ node_id: s.node_id, message: err.message });
      }
    }

    console.log(`[FuelFinder] Station batch ${batchNumber}: ${batch.length} received`);
    if (batch.length < BATCH_SIZE) break;
    batchNumber++;
  }

  try {
    await recordSyncState(pool);
  } catch (err) {
    errors.push({ phase: 'recordSyncState', message: err.message });
  }

  const summary = { batches: batchNumber, stationsSeen, stationsUpserted, errors };
  console.log('[FuelFinder] Station sync complete:', JSON.stringify({
    batches: summary.batches,
    stationsSeen,
    stationsUpserted,
    errorCount: errors.length,
  }));
  return summary;
}

module.exports = { syncStations, upsertStation, BATCH_SIZE };

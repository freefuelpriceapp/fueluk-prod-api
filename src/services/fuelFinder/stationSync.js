'use strict';
const { getPool } = require('../../config/db');
const { stationToRow } = require('./mapping');

/**
 * Map of Fuel Finder fuel_type code -> price column it backs.
 * When a station's `fuel_types` array does NOT contain a code, we
 * explicitly clear the corresponding price column so a stale price
 * from a lower-priority source (e.g. an old Apple Green CMA reading)
 * cannot survive forever.
 */
const FUEL_TYPE_PRICE_COLUMNS = {
  E10: { priceColumn: 'e10_price', sourceColumn: 'e10_source', tsColumn: 'e10_updated_at' },
  E5: { priceColumn: 'super_unleaded_price', sourceColumn: 'super_unleaded_source', tsColumn: 'super_unleaded_updated_at' },
  B7_STANDARD: { priceColumn: 'diesel_price', sourceColumn: 'diesel_source', tsColumn: 'diesel_updated_at' },
  B7_PREMIUM: { priceColumn: 'premium_diesel_price', sourceColumn: 'premium_diesel_source', tsColumn: 'premium_diesel_updated_at' },
};

/**
 * Clear price fields for fuel types Fuel Finder reports the station
 * does NOT stock. This is the authoritative fix for stations whose
 * upstream brand feed left a stale value behind (e.g. Apple Green
 * Small Heath B10 0AE — 140p super unleaded that the brand's own
 * feed flags as "unavailable"). We only clear fields whose current
 * source is NOT 'fuel_finder' (we trust ourselves) — and we do not
 * touch any field where the upstream feed has not yet certified
 * the fuel-type list (i.e. fuel_types is null/empty).
 */
async function clearMissingFuelTypePrices(pool, row) {
  if (!row || !row.fuel_finder_node_id) return 0;
  const list = Array.isArray(row.fuel_types) ? row.fuel_types : null;
  if (!list || list.length === 0) return 0;
  const stocked = new Set(list.map((c) => String(c).toUpperCase()));
  const clears = [];
  for (const [code, cols] of Object.entries(FUEL_TYPE_PRICE_COLUMNS)) {
    if (stocked.has(code)) continue;
    clears.push(cols);
  }
  if (clears.length === 0) return 0;

  const setParts = [];
  for (const cols of clears) {
    setParts.push(`${cols.priceColumn} = NULL`);
    setParts.push(`${cols.sourceColumn} = NULL`);
    setParts.push(`${cols.tsColumn} = NULL`);
  }
  const res = await pool.query(
    `UPDATE stations
        SET ${setParts.join(', ')}
      WHERE fuel_finder_node_id = $1
        AND (
          ${clears.map((c, i) => `(${c.priceColumn} IS NOT NULL AND COALESCE(${c.sourceColumn}, '') <> 'fuel_finder')`).join(' OR ')}
        )`,
    [row.fuel_finder_node_id]
  );
  return res.rowCount;
}

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
        // After upsert, clear any prices for fuel types the station does
        // not actually stock. This is the explicit clearing rule from the
        // brief — a stale 140p super_unleaded value that survives because
        // the lower-priority feed marks it "unavailable" gets purged here.
        try {
          await clearMissingFuelTypePrices(pool, row);
        } catch (err) {
          // Non-fatal: never let a clear failure abort the wider sync.
          console.warn(`[FuelFinder] clearMissingFuelTypePrices failed for ${s.node_id}:`, err.message);
        }
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

module.exports = {
  syncStations,
  upsertStation,
  clearMissingFuelTypePrices,
  FUEL_TYPE_PRICE_COLUMNS,
  BATCH_SIZE,
};

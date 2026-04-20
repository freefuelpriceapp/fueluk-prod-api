'use strict';
const { getPool } = require('../../config/db');
const { pricesToColumnUpdates, SOURCE_TAG } = require('./mapping');

/**
 * Incremental price updates from Fuel Finder.
 *
 * We persist the highest `price_last_updated` timestamp we have seen in
 * `fuel_finder_sync_state.last_price_effective_ts` and pass it to the next
 * call as `effective-start-timestamp`, so each run only receives changed
 * prices.
 *
 * Fuel Finder identifies a station by `node_id` — we store that on the
 * `stations` row as `fuel_finder_node_id` during stationSync, so price
 * updates are matched by that key.
 */

const BATCH_SIZE = 500;
const MAX_BATCHES = 200;
// Safety net: if we've never synced, start from N days ago so the first
// successful run fetches all available historical prices rather than
// only the last hour.
const FIRST_RUN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DELAY_BETWEEN_BATCHES_MS = 2000;
const MAX_CONSECUTIVE_ERRORS = 3;

async function readState(pool) {
  const { rows } = await pool.query(
    `SELECT last_price_effective_ts FROM fuel_finder_sync_state WHERE id = 1`
  );
  return rows[0] || null;
}

async function writeState(pool, effectiveTs) {
  await pool.query(
    `UPDATE fuel_finder_sync_state
       SET last_price_sync_at = NOW(),
           last_price_effective_ts = COALESCE($1, last_price_effective_ts),
           updated_at = NOW()
     WHERE id = 1`,
    [effectiveTs]
  );
}

/**
 * Apply an array of column updates to a single station, keyed by
 * fuel_finder_node_id. Builds a single UPDATE with dynamic SET clauses
 * so we don't issue one query per fuel.
 */
async function applyPriceUpdates(pool, nodeId, updates) {
  if (!updates || updates.length === 0) return 0;
  const setParts = [];
  const values = [nodeId];
  let idx = 2;
  for (const u of updates) {
    setParts.push(`${u.priceColumn} = $${idx}`);
    values.push(u.price);
    idx++;
    setParts.push(`${u.sourceColumn} = $${idx}`);
    values.push(SOURCE_TAG);
    idx++;
  }
  setParts.push('last_updated = NOW()');
  const res = await pool.query(
    `UPDATE stations SET ${setParts.join(', ')} WHERE fuel_finder_node_id = $1`,
    values
  );
  return res.rowCount;
}

/**
 * syncPrices — pulls incremental price updates and writes them back.
 * @param {{ apiClient: object, pool?: object, now?: () => Date }} deps
 */
async function syncPrices({ apiClient, pool = getPool(), now = () => new Date(), delayMs = DELAY_BETWEEN_BATCHES_MS }) {
  if (!apiClient) throw new Error('syncPrices requires apiClient');

  const state = await readState(pool);
  let effectiveStart = state && state.last_price_effective_ts
    ? new Date(state.last_price_effective_ts).toISOString()
    : new Date(now().getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();

  console.log(`[FuelFinder] Starting price sync from ${effectiveStart}...`);

  let batchNumber = 1;
  let pricesSeen = 0;
  let stationsUpdated = 0;
  let highestTs = state && state.last_price_effective_ts
    ? new Date(state.last_price_effective_ts)
    : null;
  const errors = [];
  let consecutiveErrors = 0;

  while (batchNumber <= MAX_BATCHES) {
    let batch;
    try {
      batch = await apiClient.getPricesBatch(batchNumber, effectiveStart);
    } catch (err) {
      console.error(`[FuelFinder] Price batch ${batchNumber} failed:`, err.message);
      errors.push({ batch: batchNumber, message: err.message });
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[FuelFinder] Aborting price sync after ${consecutiveErrors} consecutive batch failures`);
        break;
      }
      batchNumber++;
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    consecutiveErrors = 0;
    if (!batch || batch.length === 0) break;
    pricesSeen += batch.length;

    for (const record of batch) {
      const updates = pricesToColumnUpdates(record);
      if (updates.length === 0) continue;
      try {
        const rowCount = await applyPriceUpdates(pool, record.node_id, updates);
        if (rowCount > 0) stationsUpdated++;
      } catch (err) {
        errors.push({ node_id: record.node_id, message: err.message });
      }
      for (const u of updates) {
        if (u.updatedAt) {
          const ts = new Date(u.updatedAt);
          if (!highestTs || ts > highestTs) highestTs = ts;
        }
      }
    }

    if (batch.length < BATCH_SIZE) break;
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
    batchNumber++;
  }

  const nextEffectiveTs = highestTs ? highestTs.toISOString() : null;
  try {
    await writeState(pool, nextEffectiveTs);
  } catch (err) {
    errors.push({ phase: 'writeState', message: err.message });
  }

  const summary = {
    batches: batchNumber,
    pricesSeen,
    stationsUpdated,
    nextEffectiveTs,
    errors,
  };
  console.log('[FuelFinder] Price sync complete:', JSON.stringify({
    batches: summary.batches,
    pricesSeen,
    stationsUpdated,
    nextEffectiveTs,
    errorCount: errors.length,
  }));
  return summary;
}

module.exports = { syncPrices, applyPriceUpdates, readState, writeState };

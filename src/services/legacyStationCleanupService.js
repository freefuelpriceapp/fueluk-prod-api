'use strict';

const { getPool } = require('../config/db');

/**
 * legacyStationCleanupService.js
 *
 * One-shot cleanup for the legacy station rows that were inserted by the
 * (now-retired) `scheduleFuelSync` brand-direct scraper and the
 * `applegreen_official` HTML scraper. Both writers were turned off in
 * PR #42 (2026-06-15); this service removes the rows they left behind.
 *
 * Why this exists
 * ---------------
 * The `stations` table was being written by three jobs:
 *   1. Fuel Finder (statutory feed)        — `ff-*` ids, source NULL
 *   2. scheduleFuelSync (brand JSON URLs)  — `gcqd-*` ids, source='gov'
 *   3. nonGovFuelData scraper              — source='applegreen_official' (18 rows)
 *
 * Jobs 2 and 3 produced duplicate forecourts of Fuel Finder's data, with
 * the 2-hour gov sync stamping last_updated = NOW() on every upsert. This
 * kept the duplicate rows passing the freshness gate in
 * stationRepository.getNearbyStations(orderBy='price'), which is what
 * surfaced the Birmingham 135.8p Applegreen ghosts on /stations/cheapest.
 *
 * PR #42 turned off the writers. This service deletes the existing rows.
 *
 * Safety
 * ------
 * * Runs entirely inside a single transaction (`BEGIN; ... COMMIT;`).
 * * Foreign keys on price_history, price_alerts, user_favourites,
 *   non_gov_prices all cascade on delete, so child rows are tidied
 *   automatically.
 * * Records pre-delete and post-delete counts so the endpoint response
 *   is its own audit trail.
 * * Idempotent: a second call deletes 0 rows.
 * * RDS snapshot `pre-gov-cleanup-2026-06-15` was taken before the first
 *   run for full rollback safety.
 *
 * Returns:
 *   {
 *     gcqdRowsDeleted: number,
 *     applegreenOfficialRowsDeleted: number,
 *     userFavouritesCollateral: number,
 *     priceAlertsCollateral: number,
 *     priceHistoryCollateral: number,
 *     before: { totalStations, gcqdStations, applegreenOfficialStations },
 *     after:  { totalStations, gcqdStations, applegreenOfficialStations },
 *     durationMs: number,
 *   }
 */
async function cleanupLegacyStationRows() {
  const startedAt = Date.now();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Pre-delete inventory.
    const beforeRow = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE TRUE)                                              AS total,
        COUNT(*) FILTER (WHERE id LIKE 'gcqd%' OR source = 'gov')                 AS gcqd,
        COUNT(*) FILTER (WHERE source = 'applegreen_official')                    AS applegreen_official
      FROM stations
    `);
    const before = {
      totalStations: Number(beforeRow.rows[0].total),
      gcqdStations: Number(beforeRow.rows[0].gcqd),
      applegreenOfficialStations: Number(beforeRow.rows[0].applegreen_official),
    };

    // 2. Count collateral damage on dependent tables BEFORE we delete the
    //    parent rows, so we can surface it in the response. After the
    //    CASCADE the counts would all be zero and we'd lose visibility.
    const collateralQuery = `
      SELECT
        (SELECT COUNT(*) FROM user_favourites WHERE station_id IN (
            SELECT id FROM stations
            WHERE id LIKE 'gcqd%' OR source IN ('gov', 'applegreen_official')
        )) AS uf,
        (SELECT COUNT(*) FROM price_alerts WHERE station_id IN (
            SELECT id FROM stations
            WHERE id LIKE 'gcqd%' OR source IN ('gov', 'applegreen_official')
        )) AS pa,
        (SELECT COUNT(*) FROM price_history WHERE station_id IN (
            SELECT id FROM stations
            WHERE id LIKE 'gcqd%' OR source IN ('gov', 'applegreen_official')
        )) AS ph
    `;
    const collateral = await client.query(collateralQuery);
    const userFavouritesCollateral = Number(collateral.rows[0].uf);
    const priceAlertsCollateral = Number(collateral.rows[0].pa);
    const priceHistoryCollateral = Number(collateral.rows[0].ph);

    // 3. Delete gcqd-* rows. We match on BOTH the id prefix AND source='gov'
    //    so we catch any stragglers that had their id mangled but kept the
    //    source label, or vice versa. Cascades drop child rows.
    const gcqdDelete = await client.query(`
      DELETE FROM stations
      WHERE id LIKE 'gcqd%' OR source = 'gov'
    `);
    const gcqdRowsDeleted = gcqdDelete.rowCount || 0;

    // 4. Delete applegreen_official rows. These are the 18 HTML-scraped
    //    Applegreen forecourts whose unleaded prices were being written
    //    into petrol_price (the E5 column) — a misclassification per the
    //    fuel taxonomy (unleaded == E10 or E5/petrol).
    const agoDelete = await client.query(`
      DELETE FROM stations
      WHERE source = 'applegreen_official'
    `);
    const applegreenOfficialRowsDeleted = agoDelete.rowCount || 0;

    // 5. Post-delete inventory for the audit trail.
    const afterRow = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE TRUE)                                              AS total,
        COUNT(*) FILTER (WHERE id LIKE 'gcqd%' OR source = 'gov')                 AS gcqd,
        COUNT(*) FILTER (WHERE source = 'applegreen_official')                    AS applegreen_official
      FROM stations
    `);
    const after = {
      totalStations: Number(afterRow.rows[0].total),
      gcqdStations: Number(afterRow.rows[0].gcqd),
      applegreenOfficialStations: Number(afterRow.rows[0].applegreen_official),
    };

    // 6. Sanity check before commit: both legacy sources must be empty,
    //    total must equal before.total - rows_deleted exactly. If not,
    //    something is wrong (e.g. a writer we didn't catch) — abort.
    const expectedTotalAfter =
      before.totalStations - gcqdRowsDeleted - applegreenOfficialRowsDeleted;
    if (
      after.gcqdStations !== 0 ||
      after.applegreenOfficialStations !== 0 ||
      after.totalStations !== expectedTotalAfter
    ) {
      throw new Error(
        `Cleanup safety check failed: expected total ${expectedTotalAfter}, ` +
        `got ${after.totalStations}; gcqd_after=${after.gcqdStations}, ` +
        `applegreen_after=${after.applegreenOfficialStations}. Rolling back.`
      );
    }

    await client.query('COMMIT');

    return {
      gcqdRowsDeleted,
      applegreenOfficialRowsDeleted,
      userFavouritesCollateral,
      priceAlertsCollateral,
      priceHistoryCollateral,
      before,
      after,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { cleanupLegacyStationRows };

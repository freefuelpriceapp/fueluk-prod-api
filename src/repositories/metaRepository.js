/**
 * metaRepository.js
 * DB queries for data freshness / last-updated metadata.
 */

const { query } = require('../config/db');

/**
 * Returns the timestamp of the most recent successful ingestion run.
 */
async function getLastUpdated() {
  const result = await query(
    `SELECT completed_at, records_inserted, records_updated, source_name
     FROM ingestion_runs
     WHERE status = 'success'
     ORDER BY completed_at DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

/**
 * Returns the total count of active stations in the DB.
 */
async function getStationCount() {
  const result = await query(
    `SELECT COUNT(*) AS total FROM stations WHERE is_active = true`
  );
  return parseInt(result.rows[0]?.total || 0, 10);
}

/**
 * Returns the total count of current price records.
 */
async function getPriceCount() {
  const result = await query(
    `SELECT COUNT(*) AS total FROM station_prices_current`
  );
  return parseInt(result.rows[0]?.total || 0, 10);
}

/**
 * Returns a summary of the last N ingestion runs.
 */
async function getIngestionRunSummary(limit = 5) {
  const result = await query(
    `SELECT id, source_name, status, records_inserted, records_updated,
            started_at, completed_at, error_message
     FROM ingestion_runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  getLastUpdated,
  getStationCount,
  getPriceCount,
  getIngestionRunSummary,
};

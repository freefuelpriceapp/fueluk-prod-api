'use strict';
const cron = require('node-cron');
const { getPool } = require('../config/db');

/**
 * retentionJob.js — Sprint 4
 * Nightly job that deletes price_history rows older than 90 days.
 * Keeps the database lean and avoids unbounded table growth.
 *
 * Schedule: daily at 03:00 Europe/London (configurable via RETENTION_CRON).
 * Retention window: 90 days (configurable via RETENTION_DAYS).
 */

const DEFAULT_RETENTION_DAYS = 90;

/**
 * runRetention
 * Deletes all price_history rows older than RETENTION_DAYS.
 * Returns the number of deleted rows.
 */
async function runRetention() {
  const retentionDays = parseInt(process.env.RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10);
  const pool = getPool();
  const startedAt = new Date();

  console.log(`[RetentionJob] Running at ${startedAt.toISOString()} — purging price_history older than ${retentionDays} days`);

  try {
    const result = await pool.query(
      `DELETE FROM price_history
       WHERE recorded_at < NOW() - INTERVAL '1 day' * $1`,
      [retentionDays]
    );

    const deleted = result.rowCount;
    const durationMs = Date.now() - startedAt;
    console.log(`[RetentionJob] Done. Deleted ${deleted} row(s) in ${durationMs}ms.`);
    return { deleted, retentionDays, durationMs };
  } catch (err) {
    console.error('[RetentionJob] Error during retention purge:', err.message);
    throw err;
  }
}

/**
 * startRetentionJob
 * Schedules the nightly retention purge.
 * Default: 03:00 every night (Europe/London).
 */
function startRetentionJob() {
  const schedule = process.env.RETENTION_CRON || '0 3 * * *'; // 03:00 daily
  console.log(`[RetentionJob] Starting retention scheduler with schedule: "${schedule}"`);

  cron.schedule(schedule, async () => {
    console.log('[RetentionJob] Cron trigger fired');
    try {
      await runRetention();
    } catch (err) {
      console.error('[RetentionJob] Uncaught error in scheduled run:', err.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/London',
  });
}

module.exports = { startRetentionJob, runRetention };

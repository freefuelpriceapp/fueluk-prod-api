'use strict';
const cron = require('node-cron');
const { runFullIngest } = require('../services/ingestService');

/**
 * ingestRunner.js — Sprint 2
 * Schedules the full ingest pipeline using node-cron.
 *
 * Default schedule: every 6 hours (configurable via INGEST_CRON env var).
 * Also exports startIngestRunner() for server.js to call on boot,
 * and runNow() for the admin trigger endpoint.
 *
 * Prevents overlapping runs using a simple lock flag.
 */

const DEFAULT_CRON = '0 */6 * * *'; // Every 6 hours
let isRunning = false;
let cronJob = null;

async function runNow() {
  if (isRunning) {
    console.warn('[IngestRunner] Ingest already in progress — skipping concurrent run');
    return { skipped: true, reason: 'already_running' };
  }
  isRunning = true;
  try {
    const summary = await runFullIngest();
    return summary;
  } finally {
    isRunning = false;
  }
}

function startIngestRunner() {
  const schedule = process.env.INGEST_CRON || DEFAULT_CRON;
  console.log(`[IngestRunner] Starting cron scheduler with schedule: "${schedule}"`);

  cronJob = cron.schedule(schedule, async () => {
    console.log('[IngestRunner] Cron trigger fired');
    await runNow();
  }, {
    scheduled: true,
    timezone: 'Europe/London',
  });

  // Run immediately on startup so data is fresh from first request
  if (process.env.INGEST_ON_BOOT !== 'false') {
    console.log('[IngestRunner] Running initial ingest on boot...');
    runNow().catch(err => {
      console.error('[IngestRunner] Boot ingest failed:', err.message);
    });
  }

  return cronJob;
}

function stopIngestRunner() {
  if (cronJob) {
    cronJob.destroy();
    cronJob = null;
    console.log('[IngestRunner] Cron job stopped');
  }
}

module.exports = { startIngestRunner, stopIngestRunner, runNow };

'use strict';

/**
 * diagnosticsHealthCheck.js — B-06
 *
 * Lightweight cron-scheduled health-check that evaluates regional null rates
 * and stale-station ratios from the diagnostics data. When any region exceeds
 * 30% null rate, or the stale_over_threshold count exceeds 5% of total
 * stations, a JSON alert is POSTed to HEALTHCHECK_WEBHOOK_URL.
 *
 * Silently noops if HEALTHCHECK_WEBHOOK_URL is unset — no noise in local dev.
 *
 * Uses node-cron (already a project dependency). Scheduled every 30 minutes
 * so issues surface within half an hour of manifesting; configurable via
 * HEALTHCHECK_CRON env var.
 *
 * Critical privacy rule: no price data or PII is included in the webhook payload.
 */

const cron = require('node-cron');
const { getPool } = require('../config/db');

const NULL_RATE_THRESHOLD_PCT = 30;   // same as REGION_BLACKOUT_THRESHOLD_PCT
const STALE_THRESHOLD_PCT = 5;        // 5% of total stations stale → alert
const DEFAULT_CRON = '*/30 * * * *';  // every 30 minutes

// Keep regionFromPostcode in sync with diagnostics.js (same logic).
function regionFromPostcode(pc) {
  if (!pc) return null;
  const cleaned = String(pc).replace(/\s+/g, '').toUpperCase();
  if (!cleaned) return null;
  if (cleaned.startsWith('BT')) return 'BT';
  const m = cleaned.match(/^([A-Z]{1,2})(\d[A-Z\d]?)/);
  if (!m) return null;
  return m[1] + m[2];
}

async function computeHealthSnapshot(pool) {
  // Regional null rates
  const { rows: stationRows } = await pool.query(`
    SELECT postcode,
           (petrol_price IS NULL AND diesel_price IS NULL AND e10_price IS NULL) AS all_null
    FROM stations
    WHERE postcode IS NOT NULL AND postcode <> ''
  `);

  const counts = new Map();
  for (const r of stationRows) {
    const region = regionFromPostcode(r.postcode);
    if (!region) continue;
    let entry = counts.get(region);
    if (!entry) { entry = { total: 0, nulls: 0 }; counts.set(region, entry); }
    entry.total += 1;
    if (r.all_null) entry.nulls += 1;
  }

  const breachedRegions = [];
  for (const [region, entry] of counts) {
    if (entry.total < 10) continue;
    const pct = (entry.nulls / entry.total) * 100;
    if (pct >= NULL_RATE_THRESHOLD_PCT) {
      breachedRegions.push({
        region,
        null_pct: Number(pct.toFixed(1)),
        total_stations: entry.total,
        null_stations: entry.nulls,
      });
    }
  }

  // Stale-over-threshold count
  const staleThresholdHours = Number(process.env.STALE_THRESHOLD_HOURS || 48);
  const { rows: staleRows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE last_updated < NOW() - ($1 || ' hours')::interval
      )::int AS stale_over_threshold
    FROM stations
  `, [String(staleThresholdHours)]);

  const total = staleRows[0]?.total || 0;
  const staleCount = staleRows[0]?.stale_over_threshold || 0;
  const stalePct = total > 0 ? (staleCount / total) * 100 : 0;

  return {
    breachedRegions,
    total,
    staleCount,
    stalePct: Number(stalePct.toFixed(1)),
    staleThresholdHours,
  };
}

async function runDiagnosticsHealthCheck({ now = new Date() } = {}) {
  const webhookUrl = process.env.HEALTHCHECK_WEBHOOK_URL;
  if (!webhookUrl) {
    // No webhook configured — silent noop.
    return { skipped: true, reason: 'HEALTHCHECK_WEBHOOK_URL not set' };
  }

  let snapshot;
  try {
    const pool = getPool();
    snapshot = await computeHealthSnapshot(pool);
  } catch (err) {
    // DB errors must not crash the cron process.
    console.warn('[DiagnosticsHealthCheck] DB query failed:', err.message);
    return { error: err.message };
  }

  const alerts = [];

  // Regional null-rate breaches
  for (const region of snapshot.breachedRegions) {
    alerts.push({
      type: 'regional_null_rate_exceeded',
      region: region.region,
      null_pct: region.null_pct,
      total_stations: region.total_stations,
      null_stations: region.null_stations,
      threshold_pct: NULL_RATE_THRESHOLD_PCT,
    });
  }

  // Stale-over-threshold breach
  if (snapshot.stalePct > STALE_THRESHOLD_PCT) {
    alerts.push({
      type: 'stale_over_threshold_exceeded',
      stale_pct: snapshot.stalePct,
      stale_count: snapshot.staleCount,
      total_stations: snapshot.total,
      threshold_pct: STALE_THRESHOLD_PCT,
      threshold_hours: snapshot.staleThresholdHours,
    });
  }

  if (alerts.length === 0) {
    return { fired: false, checked_at: now.toISOString() };
  }

  const payload = {
    service: 'fueluk-api',
    checked_at: now.toISOString(),
    alert_count: alerts.length,
    alerts,
  };

  try {
    // node 18+ has global fetch; fall back to no-op if unavailable.
    if (typeof fetch === 'function') {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      console.log(`[DiagnosticsHealthCheck] Webhook POST → ${res.status}, alerts=${alerts.length}`);
    } else {
      console.warn('[DiagnosticsHealthCheck] global fetch unavailable — webhook skipped');
    }
  } catch (err) {
    // Webhook errors must not crash the cron process.
    console.warn('[DiagnosticsHealthCheck] Webhook POST failed:', err.message);
    return { fired: true, webhook_error: err.message, alerts };
  }

  return { fired: true, alerts, checked_at: now.toISOString() };
}

function startDiagnosticsHealthCheck() {
  const schedule = process.env.HEALTHCHECK_CRON || DEFAULT_CRON;
  console.log(`[DiagnosticsHealthCheck] Scheduling with cron: "${schedule}"`);
  cron.schedule(schedule, async () => {
    try {
      await runDiagnosticsHealthCheck();
    } catch (err) {
      console.error('[DiagnosticsHealthCheck] Uncaught error:', err.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/London',
  });
}

module.exports = {
  startDiagnosticsHealthCheck,
  runDiagnosticsHealthCheck,
  computeHealthSnapshot,
  regionFromPostcode,
  NULL_RATE_THRESHOLD_PCT,
  STALE_THRESHOLD_PCT,
};

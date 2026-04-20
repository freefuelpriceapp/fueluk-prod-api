'use strict';

/**
 * diagnostics.js
 * GET /api/v1/diagnostics — data-quality snapshot for oncall / monitoring.
 *
 * Returns station counts, price coverage, staleness, ingest recency, and
 * alert stats. Derives a top-level status of healthy/degraded/unhealthy
 * based on gov-sync recency and stale-station ratio.
 */

const router = require('express').Router();
const { getPool } = require('../config/db');

function deriveStatus({ lastGovSyncAgeHours, stationTotal, staleOver7Days }) {
  const stalePct = stationTotal > 0 ? (staleOver7Days / stationTotal) * 100 : 0;
  const syncAge = lastGovSyncAgeHours == null ? Infinity : lastGovSyncAgeHours;

  if (syncAge > 12 || stalePct > 15) return 'unhealthy';
  if (syncAge >= 6 || stalePct >= 5) return 'degraded';
  return 'healthy';
}

router.get('/', async (req, res, next) => {
  try {
    const pool = getPool();

    const [stationStats, brandStats, ingestStats, alertStats] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(petrol_price)::int AS with_petrol_price,
          COUNT(diesel_price)::int AS with_diesel_price,
          COUNT(e10_price)::int AS with_e10_price,
          COUNT(*) FILTER (
            WHERE petrol_price IS NULL
              AND diesel_price IS NULL
              AND e10_price IS NULL
          )::int AS missing_all_prices,
          COUNT(*) FILTER (WHERE last_updated < NOW() - INTERVAL '7 days')::int AS stale_over_7_days,
          COUNT(*) FILTER (WHERE last_updated < NOW() - INTERVAL '30 days')::int AS stale_over_30_days,
          MAX(last_updated) AS last_station_update
        FROM stations
      `),
      pool.query(`
        SELECT brand, COUNT(*)::int AS count
        FROM stations
        WHERE brand IS NOT NULL AND brand <> ''
        GROUP BY brand
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          MAX(recorded_at) FILTER (WHERE source = 'gov') AS last_gov_sync,
          MAX(recorded_at) FILTER (WHERE source = 'fuel_finder') AS last_fuel_finder_price_sync,
          COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '24 hours')::int AS rows_24h,
          COUNT(*)::int AS rows_total
        FROM price_history
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE active = true)::int AS total_active,
          COUNT(*) FILTER (WHERE last_notified_at > NOW() - INTERVAL '24 hours')::int AS fired_last_24h
        FROM price_alerts
      `),
    ]);

    const s = stationStats.rows[0] || {};
    const ingest = ingestStats.rows[0] || {};
    const alerts = alertStats.rows[0] || { total_active: 0, fired_last_24h: 0 };

    const brandsAll = brandStats.rows || [];
    const top5 = brandsAll.slice(0, 5).map(r => ({ name: r.brand, count: r.count }));

    // Prefer a real last-ingest timestamp when price_history has any gov rows;
    // fall back to stations.last_updated so brand-new deployments still report a value.
    const lastGovSync = ingest.last_gov_sync || s.last_station_update || null;
    // stations.last_updated is the canonical "last station sync" for Fuel Finder brand imports.
    const lastFuelFinderStationSync = s.last_station_update || null;

    const lastGovSyncAgeHours = lastGovSync
      ? (Date.now() - new Date(lastGovSync).getTime()) / 3_600_000
      : null;

    const status = deriveStatus({
      lastGovSyncAgeHours,
      stationTotal: s.total || 0,
      staleOver7Days: s.stale_over_7_days || 0,
    });

    res.json({
      status,
      timestamp: new Date().toISOString(),
      stations: {
        total: s.total || 0,
        with_petrol_price: s.with_petrol_price || 0,
        with_diesel_price: s.with_diesel_price || 0,
        with_e10_price: s.with_e10_price || 0,
        missing_all_prices: s.missing_all_prices || 0,
        stale_over_7_days: s.stale_over_7_days || 0,
        stale_over_30_days: s.stale_over_30_days || 0,
      },
      brands: {
        total_distinct: brandsAll.length,
        top_5: top5,
      },
      ingest: {
        last_gov_sync: lastGovSync ? new Date(lastGovSync).toISOString() : null,
        last_fuel_finder_price_sync: ingest.last_fuel_finder_price_sync
          ? new Date(ingest.last_fuel_finder_price_sync).toISOString()
          : null,
        last_fuel_finder_station_sync: lastFuelFinderStationSync
          ? new Date(lastFuelFinderStationSync).toISOString()
          : null,
        price_history_rows_24h: ingest.rows_24h || 0,
        price_history_rows_total: ingest.rows_total || 0,
      },
      alerts: {
        total_active: alerts.total_active || 0,
        fired_last_24h: alerts.fired_last_24h || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._deriveStatus = deriveStatus;

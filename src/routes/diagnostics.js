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
const { runBackfillQuarantine } = require('../jobs/backfillQuarantine');
const vehicleSpecService = require('../services/vehicleSpecService');
const dvsaService = require('../services/dvsaService');
const { getGroundTruthStats } = require('../repositories/groundtruthRepository');

function buildVehicleMotDiagnostics() {
  const flagEnabled = dvsaService.isConfigured();
  const keyPresent = Boolean(process.env.DVSA_API_KEY);
  const snapshot = typeof dvsaService.getMetricsSnapshot === 'function'
    ? dvsaService.getMetricsSnapshot()
    : {};
  return {
    provider: 'dvsa',
    flag_enabled: flagEnabled,
    key_present: keyPresent,
    last_24h_calls: snapshot.last_24h_calls || 0,
    last_24h_errors: snapshot.last_24h_errors || 0,
    last_24h_not_found: snapshot.last_24h_not_found || 0,
    token_cache_hit_rate: snapshot.token_cache_hit_rate == null ? null : Number(snapshot.token_cache_hit_rate.toFixed(3)),
    window_started_at: snapshot.window_started_at || null,
  };
}

// Outcode = first chunk of UK postcode before the space (e.g. "B10", "BT4").
// We bucket Northern Ireland (BT*) into a single "BT" region so the audit's
// 90% NI blackout shows up cleanly instead of as 100+ individual outcodes.
const REGION_BLACKOUT_THRESHOLD_PCT = 30;
const REGIONAL_BLACKOUT_EVENT = 'regional_blackout_detected';

function regionFromPostcode(pc) {
  if (!pc) return null;
  const cleaned = String(pc).replace(/\s+/g, '').toUpperCase();
  if (!cleaned) return null;
  if (cleaned.startsWith('BT')) return 'BT';
  // Outcode = leading letters + leading digits
  const m = cleaned.match(/^([A-Z]{1,2})(\d[A-Z\d]?)/);
  if (!m) return null;
  return m[1] + m[2];
}

async function getRegionalNullRates(pool, { logger = console } = {}) {
  let rows;
  try {
    const res = await pool.query(`
      SELECT postcode,
             (petrol_price IS NULL AND diesel_price IS NULL AND e10_price IS NULL) AS all_null
      FROM stations
      WHERE postcode IS NOT NULL AND postcode <> ''
    `);
    rows = res.rows || [];
  } catch (err) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[diagnostics] regional null-rate query failed: ${err.message}`);
    }
    return {};
  }

  const counts = new Map();
  for (const r of rows) {
    const region = regionFromPostcode(r.postcode);
    if (!region) continue;
    let entry = counts.get(region);
    if (!entry) { entry = { total: 0, nulls: 0 }; counts.set(region, entry); }
    entry.total += 1;
    if (r.all_null) entry.nulls += 1;
  }

  const out = {};
  for (const [region, entry] of counts) {
    if (entry.total < 10) continue; // ignore micro-regions
    const pct = (entry.nulls / entry.total) * 100;
    out[region] = Number(pct.toFixed(1));
    if (pct >= REGION_BLACKOUT_THRESHOLD_PCT && logger && typeof logger.warn === 'function') {
      logger.warn(JSON.stringify({
        level: 'warn',
        event: REGIONAL_BLACKOUT_EVENT,
        region,
        null_pct: Number(pct.toFixed(1)),
        total_stations: entry.total,
        null_stations: entry.nulls,
      }));
    }
  }
  return out;
}

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

    const staleThresholdHoursRaw = Number(req.query.stale_threshold_hours);
    const staleThresholdHours = Number.isFinite(staleThresholdHoursRaw) && staleThresholdHoursRaw > 0
      ? staleThresholdHoursRaw
      : 48;

    const [stationStats, brandStats, ingestStats, alertStats, priceStats, sourceStats] = await Promise.all([
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
          COUNT(*) FILTER (WHERE last_updated > NOW() - INTERVAL '1 hour')::int AS updated_last_1h,
          COUNT(*) FILTER (WHERE last_updated > NOW() - INTERVAL '6 hours')::int AS updated_last_6h,
          COUNT(*) FILTER (WHERE last_updated > NOW() - INTERVAL '24 hours')::int AS updated_last_24h,
          COUNT(*) FILTER (WHERE last_updated > NOW() - INTERVAL '48 hours')::int AS updated_last_48h,
          COUNT(*) FILTER (WHERE last_updated < NOW() - ($1 || ' hours')::interval)::int AS stale_over_threshold,
          MAX(last_updated) AS last_station_update
        FROM stations
      `, [String(staleThresholdHours)]),
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
      pool.query(`
        SELECT
          AVG(petrol_price)::numeric(6,2) AS avg_petrol,
          AVG(diesel_price)::numeric(6,2) AS avg_diesel,
          AVG(e10_price)::numeric(6,2) AS avg_e10,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY petrol_price)::numeric(6,2) AS median_petrol,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY diesel_price)::numeric(6,2) AS median_diesel,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e10_price)::numeric(6,2) AS median_e10
        FROM stations
      `),
      pool.query(`
        SELECT
          COALESCE(petrol_source, 'unknown') AS source,
          AVG(petrol_price)::numeric(6,2) AS avg_petrol,
          AVG(diesel_price)::numeric(6,2) AS avg_diesel,
          AVG(e10_price)::numeric(6,2) AS avg_e10,
          COUNT(*)::int AS station_count
        FROM stations
        GROUP BY COALESCE(petrol_source, 'unknown')
        ORDER BY station_count DESC
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

    const price = priceStats.rows[0] || {};
    const toNum = (v) => (v == null ? null : Number(v));

    const bySource = (sourceStats.rows || []).map((r) => ({
      source: r.source,
      station_count: r.station_count || 0,
      avg_petrol: toNum(r.avg_petrol),
      avg_diesel: toNum(r.avg_diesel),
      avg_e10: toNum(r.avg_e10),
    }));

    res.json({
      status,
      timestamp: new Date().toISOString(),
      stale_threshold_hours: staleThresholdHours,
      stations: {
        total: s.total || 0,
        with_petrol_price: s.with_petrol_price || 0,
        with_diesel_price: s.with_diesel_price || 0,
        with_e10_price: s.with_e10_price || 0,
        missing_all_prices: s.missing_all_prices || 0,
        stale_over_7_days: s.stale_over_7_days || 0,
        stale_over_30_days: s.stale_over_30_days || 0,
        stale_over_threshold: s.stale_over_threshold || 0,
        updated_last_1h: s.updated_last_1h || 0,
        updated_last_6h: s.updated_last_6h || 0,
        updated_last_24h: s.updated_last_24h || 0,
        updated_last_48h: s.updated_last_48h || 0,
      },
      prices: {
        avg_petrol: toNum(price.avg_petrol),
        avg_diesel: toNum(price.avg_diesel),
        avg_e10: toNum(price.avg_e10),
        median_petrol: toNum(price.median_petrol),
        median_diesel: toNum(price.median_diesel),
        median_e10: toNum(price.median_e10),
        by_source: bySource,
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
      vehicle_spec: {
        provider: 'checkcardetails',
        flag_enabled: vehicleSpecService.isFlagEnabled(),
        key_present: Boolean(process.env.CHECKCARDETAILS_API_KEY),
        ...vehicleSpecService.getMetricsSnapshot(),
      },
      vehicle_mot: buildVehicleMotDiagnostics(),
      regional_null_rates: await getRegionalNullRates(pool),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/diagnostics/station/:id
 * Per-station data-quality snapshot for oncall debugging. Surfaces:
 *   - the live merged values
 *   - the per-source / per-field timestamps and currently-winning source
 *   - any quarantine flags currently set
 *   - the price_history rows for the last 7 days, grouped by source
 *
 * Useful for cases like B10 0AE where a stuck reading needs to be
 * traced back to the source feed and timestamp without shelling into
 * the database.
 */
router.get('/station/:id', async (req, res, next) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, error: 'station id required' });
    }
    const stationRes = await pool.query(
      `SELECT id, brand, name, address, postcode, lat, lng, fuel_finder_node_id,
              petrol_price, diesel_price, e10_price,
              super_unleaded_price, premium_diesel_price,
              petrol_source, diesel_source, e10_source,
              super_unleaded_source, premium_diesel_source,
              petrol_updated_at, diesel_updated_at, e10_updated_at,
              super_unleaded_updated_at, premium_diesel_updated_at,
              fuel_types, last_updated, temporary_closure, permanent_closure
         FROM stations WHERE id = $1`,
      [id]
    );
    if (!stationRes.rows.length) {
      return res.status(404).json({ success: false, error: 'station not found', id });
    }
    const s = stationRes.rows[0];

    const historyRes = await pool.query(
      `SELECT fuel_type, source, MAX(recorded_at) AS last_seen, COUNT(*)::int AS samples
         FROM price_history
        WHERE station_id = $1
          AND recorded_at > NOW() - INTERVAL '7 days'
        GROUP BY fuel_type, source
        ORDER BY fuel_type, source`,
      [id]
    );

    const nonGovRes = await pool.query(
      `SELECT fuel_type, price_pence, source, scraped_at
         FROM non_gov_prices
        WHERE station_id = $1`,
      [id]
    );

    const HOURS = 3_600_000;
    const ageHours = (ts) => {
      if (!ts) return null;
      const t = new Date(ts).getTime();
      if (!Number.isFinite(t)) return null;
      return Math.round(((Date.now() - t) / HOURS) * 10) / 10;
    };

    const fuels = {};
    const FIELDS = [
      ['petrol', 'petrol_price', 'petrol_source', 'petrol_updated_at'],
      ['diesel', 'diesel_price', 'diesel_source', 'diesel_updated_at'],
      ['e10', 'e10_price', 'e10_source', 'e10_updated_at'],
      ['super_unleaded', 'super_unleaded_price', 'super_unleaded_source', 'super_unleaded_updated_at'],
      ['premium_diesel', 'premium_diesel_price', 'premium_diesel_source', 'premium_diesel_updated_at'],
    ];
    for (const [key, priceCol, sourceCol, tsCol] of FIELDS) {
      const updatedAt = s[tsCol] || null;
      const age = ageHours(updatedAt);
      fuels[key] = {
        price: s[priceCol] != null ? Number(s[priceCol]) : null,
        winning_source: s[sourceCol] || null,
        last_updated: updatedAt ? new Date(updatedAt).toISOString() : null,
        age_hours: age,
        quarantined: s[priceCol] != null && (age == null || age > 24),
      };
    }

    return res.json({
      success: true,
      station: {
        id: s.id,
        brand: s.brand,
        name: s.name,
        address: s.address,
        postcode: s.postcode,
        fuel_finder_node_id: s.fuel_finder_node_id,
        lat: s.lat != null ? Number(s.lat) : null,
        lng: s.lng != null ? Number(s.lng) : null,
        last_updated: s.last_updated ? new Date(s.last_updated).toISOString() : null,
        temporary_closure: !!s.temporary_closure,
        permanent_closure: !!s.permanent_closure,
        upstream_fuel_types: s.fuel_types || null,
      },
      fuels,
      price_history_recent: (historyRes.rows || []).map((r) => ({
        fuel_type: r.fuel_type,
        source: r.source,
        last_seen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
        samples: r.samples,
      })),
      non_gov_prices: (nonGovRes.rows || []).map((r) => ({
        fuel_type: r.fuel_type,
        price_pence: r.price_pence != null ? Number(r.price_pence) : null,
        source: r.source,
        scraped_at: r.scraped_at ? new Date(r.scraped_at).toISOString() : null,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/diagnostics/backfill-quarantine
 * Triggers the Wave A backfill on demand. Requires the
 * X-Admin-Token header to match ADMIN_API_TOKEN; if the env var is
 * unset the endpoint is disabled. Useful post-deploy to re-evaluate
 * staleness without waiting for the next ingest cycle.
 */
router.post('/backfill-quarantine', async (req, res, next) => {
  try {
    const expected = process.env.ADMIN_API_TOKEN;
    if (!expected) {
      return res.status(503).json({ success: false, error: 'admin endpoint disabled' });
    }
    const got = req.get('X-Admin-Token');
    if (!got || got !== expected) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    const summary = await runBackfillQuarantine();
    return res.json({ success: true, summary });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/diagnostics/groundtruth
 * Returns aggregate counts for the receipt_groundtruth table.
 * For ops to verify data is flowing from the Phase 2B ingestion pipeline.
 */
router.get('/groundtruth', async (req, res, next) => {
  try {
    const stats = await getGroundTruthStats();
    return res.json(stats);
  } catch (err) {
    // Table may not exist yet on a fresh DB — return zeros rather than 500
    if (err.code === '42P01') {
      return res.json({
        total: 0,
        last_24h: 0,
        last_7d: 0,
        by_brand: {},
        by_outcode_top10: [],
      });
    }
    return next(err);
  }
});


module.exports = router;
module.exports._deriveStatus = deriveStatus;
module.exports._regionFromPostcode = regionFromPostcode;
module.exports._getRegionalNullRates = getRegionalNullRates;
module.exports._buildVehicleMotDiagnostics = buildVehicleMotDiagnostics;
module.exports.REGION_BLACKOUT_THRESHOLD_PCT = REGION_BLACKOUT_THRESHOLD_PCT;

'use strict';

/**
 * trajectoryService.js
 * Compute 7-day price trajectory per station (from price_history) and fall
 * back to a national 7-day average when a station has too few data points.
 *
 * Pure-logic helpers are exported for unit testing. The DB-touching paths
 * swallow errors and return null so endpoints never break if history is
 * unavailable.
 *
 * Feature-flagged at the controller layer (ENABLE_TRAJECTORY).
 */

const STABLE_DELTA_P = 0.5; // |delta| < 0.5p = stable
const HIGH_CONFIDENCE_MIN_POINTS = 6;
const MEDIUM_CONFIDENCE_MIN_POINTS = 4;
const NATIONAL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

// Public fuel_type → price_history.fuel_type + price column.
const FUEL_MAP = {
  E10: { history: 'e10', priceField: 'e10_price' },
  PETROL: { history: 'petrol', priceField: 'petrol_price' },
  E5: { history: 'petrol', priceField: 'petrol_price' },
  SUPER_UNLEADED: { history: 'super_unleaded', priceField: 'super_unleaded_price' },
  B7: { history: 'diesel', priceField: 'diesel_price' },
  DIESEL: { history: 'diesel', priceField: 'diesel_price' },
  PREMIUM_DIESEL: { history: 'premium_diesel', priceField: 'premium_diesel_price' },
};

function resolveFuel(fuelType) {
  const k = String(fuelType || 'E10').toUpperCase();
  return FUEL_MAP[k] || FUEL_MAP.E10;
}

/**
 * Classify a 7-day delta into direction + recommendation.
 *   delta > 0  → rising  → "Fill today — prices rising"
 *   delta < 0  → falling → "Wait a day or two — prices falling"
 *   else       → stable  → "Prices stable"
 */
function classifyDelta(deltaP) {
  if (!Number.isFinite(deltaP)) return null;
  const rounded = Math.round(deltaP * 10) / 10;
  if (Math.abs(rounded) < STABLE_DELTA_P) {
    return { direction: 'stable', delta: rounded, recommendation: 'Prices stable — fill when convenient' };
  }
  if (rounded > 0) {
    return { direction: 'rising', delta: rounded, recommendation: 'Fill today — prices rising' };
  }
  return { direction: 'falling', delta: rounded, recommendation: 'Wait a day or two — prices falling' };
}

function confidenceFor(pointCount) {
  if (pointCount >= HIGH_CONFIDENCE_MIN_POINTS) return 'high';
  if (pointCount >= MEDIUM_CONFIDENCE_MIN_POINTS) return 'medium';
  return 'low';
}

/**
 * Given a sorted array of { price_pence, recorded_at } points (oldest →
 * newest) for a single station+fuel, compute the 7-day delta. Returns
 * { delta, pointCount } or null if there is not enough data.
 *
 * Delta = (newest within window) - (oldest within window).
 */
function computeDeltaFromPoints(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const prices = points
    .map((p) => Number(p && p.price_pence))
    .filter((n) => Number.isFinite(n));
  if (prices.length < 2) return { delta: 0, pointCount: prices.length };
  const oldest = prices[0];
  const newest = prices[prices.length - 1];
  return { delta: newest - oldest, pointCount: prices.length };
}

/**
 * Build a trajectory block from a points array. Returns null when no
 * usable signal.
 */
function buildStationTrajectory(points, { fuelType, source = 'station' } = {}) {
  const d = computeDeltaFromPoints(points);
  if (!d) return null;
  const klass = classifyDelta(d.delta);
  if (!klass) return null;
  return {
    direction: klass.direction,
    delta_7d_p: klass.delta,
    confidence: source === 'national' ? 'low' : confidenceFor(d.pointCount),
    source,
    recommendation: klass.recommendation,
    fuel_type: fuelType,
  };
}

// ── DB-backed helpers (safe — swallow errors) ──────────────────────────
// Kept behind an injected pool reference so unit tests can stub.

let _pool = null;
function getPool() {
  if (_pool) return _pool;
  try {
    _pool = require('../config/db').getPool();
  } catch (_err) {
    _pool = null;
  }
  return _pool;
}
function __setPoolForTests(pool) { _pool = pool; }

/**
 * Pull the last 7 days of price_history for a station + fuel.
 * Returns [] on any failure.
 */
async function fetchStationHistory(stationId, fuelHistoryType) {
  const pool = getPool();
  if (!pool || !stationId || !fuelHistoryType) return [];
  try {
    const res = await pool.query(
      `SELECT price_pence, recorded_at
         FROM price_history
         WHERE station_id = $1
           AND fuel_type = $2
           AND recorded_at >= NOW() - INTERVAL '7 days'
         ORDER BY recorded_at ASC`,
      [stationId, fuelHistoryType],
    );
    return res.rows || [];
  } catch (_err) {
    return [];
  }
}

/**
 * Compute the national 7-day delta for a fuel type by taking the daily
 * average price across all stations and comparing oldest vs newest. Cached
 * in-memory for 30 minutes.
 */
const _nationalCache = new Map(); // fuelHistoryType → { at, value }

function __clearNationalCacheForTests() { _nationalCache.clear(); }

async function getNationalTrajectory(fuelType) {
  const { history: fuelHistoryType } = resolveFuel(fuelType);
  const key = fuelHistoryType;
  const cached = _nationalCache.get(key);
  if (cached && Date.now() - cached.at < NATIONAL_CACHE_TTL_MS) {
    return cached.value;
  }
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query(
      `SELECT DATE_TRUNC('day', recorded_at) AS day, AVG(price_pence) AS avg_price
         FROM price_history
         WHERE fuel_type = $1
           AND recorded_at >= NOW() - INTERVAL '7 days'
           AND price_pence IS NOT NULL
         GROUP BY day
         ORDER BY day ASC`,
      [fuelHistoryType],
    );
    const points = (res.rows || []).map((r) => ({
      price_pence: Number(r.avg_price),
      recorded_at: r.day,
    }));
    const traj = buildStationTrajectory(points, { fuelType, source: 'national' });
    _nationalCache.set(key, { at: Date.now(), value: traj });
    return traj;
  } catch (_err) {
    return null;
  }
}

/**
 * Annotate an array of station objects with a trajectory block each +
 * compute the single national trajectory block for the response.
 *
 * For stations with <4 usable points, we fall back to the national block
 * but tag source='national'.
 */
async function annotateTrajectory(stations, { fuelType } = {}) {
  const resolved = resolveFuel(fuelType);
  const national = await getNationalTrajectory(fuelType);

  if (!Array.isArray(stations) || !stations.length) {
    return { perStation: [], national };
  }

  const perStation = await Promise.all(
    stations.map(async (s) => {
      if (!s || typeof s !== 'object') return null;
      const rows = await fetchStationHistory(s.id, resolved.history);
      const block = buildStationTrajectory(rows, {
        fuelType: resolved.history.toUpperCase(),
        source: 'station',
      });
      if (block && block.confidence !== 'low') {
        return block;
      }
      // Fallback: use national, tagged source=national, confidence=low.
      if (national) {
        return {
          ...national,
          source: 'national',
          confidence: 'low',
        };
      }
      return null;
    }),
  );

  return { perStation, national };
}

module.exports = {
  classifyDelta,
  confidenceFor,
  computeDeltaFromPoints,
  buildStationTrajectory,
  getNationalTrajectory,
  annotateTrajectory,
  resolveFuel,
  NATIONAL_CACHE_TTL_MS,
  HIGH_CONFIDENCE_MIN_POINTS,
  MEDIUM_CONFIDENCE_MIN_POINTS,
  STABLE_DELTA_P,
  __setPoolForTests,
  __clearNationalCacheForTests,
};

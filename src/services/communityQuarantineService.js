'use strict';

/**
 * communityQuarantineService.js — F6
 * Applies active community-quarantine rows to a list of stations by nulling
 * the relevant price_per_litre field(s). The quarantine is auto-expired by
 * price_flag_quarantine.expires_at or a fresher stations.last_updated (that
 * comparison already happens inside the repo's isQuarantined query; for bulk
 * reads we do the same filter in SQL).
 *
 * Feature-flagged at the controller layer (ENABLE_PRICE_FLAGS).
 */

const FUEL_TYPE_TO_PRICE_FIELD = {
  E10: 'e10_price',
  E5: 'petrol_price',
  petrol: 'petrol_price',
  B7: 'diesel_price',
  diesel: 'diesel_price',
  super_unleaded: 'super_unleaded_price',
  premium_diesel: 'premium_diesel_price',
};

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
 * Fetch active community quarantines for the given station IDs.
 * Returns a Map: station_id → Set of fuel_type strings.
 */
async function fetchActiveQuarantinesForStations(stationIds) {
  if (!Array.isArray(stationIds) || !stationIds.length) return new Map();
  const pool = getPool();
  if (!pool) return new Map();
  try {
    const res = await pool.query(
      `SELECT q.station_id, q.fuel_type
         FROM price_flag_quarantine q
         LEFT JOIN stations s ON s.id = q.station_id
         WHERE q.station_id = ANY($1::varchar[])
           AND q.expires_at > NOW()
           AND (s.last_updated IS NULL OR s.last_updated <= q.quarantined_at)`,
      [stationIds],
    );
    const map = new Map();
    for (const row of res.rows || []) {
      let set = map.get(row.station_id);
      if (!set) {
        set = new Set();
        map.set(row.station_id, set);
      }
      set.add(row.fuel_type);
    }
    return map;
  } catch (_err) {
    return new Map();
  }
}

/**
 * Apply a quarantine map to a list of stations. Returns a new array of
 * station copies with relevant price fields nulled and a
 * `community_quarantined_fuels` array attached when something was changed.
 */
function applyQuarantineMap(stations, quarantineMap) {
  if (!Array.isArray(stations) || !quarantineMap || !quarantineMap.size) {
    return Array.isArray(stations) ? stations : [];
  }
  return stations.map((s) => {
    if (!s || typeof s !== 'object' || !s.id) return s;
    const fuels = quarantineMap.get(s.id);
    if (!fuels || !fuels.size) return s;
    const next = { ...s };
    const touched = [];
    for (const fuel of fuels) {
      const field = FUEL_TYPE_TO_PRICE_FIELD[fuel];
      if (field && next[field] != null) {
        next[field] = null;
        touched.push(fuel);
      }
    }
    if (touched.length) {
      next.community_quarantined_fuels = touched;
    }
    return next;
  });
}

async function applyCommunityQuarantine(stations) {
  if (!Array.isArray(stations) || !stations.length) return stations;
  const ids = stations
    .map((s) => (s && typeof s === 'object' ? s.id : null))
    .filter((id) => typeof id === 'string' && id.length);
  if (!ids.length) return stations;
  const map = await fetchActiveQuarantinesForStations(ids);
  return applyQuarantineMap(stations, map);
}

module.exports = {
  applyCommunityQuarantine,
  applyQuarantineMap,
  fetchActiveQuarantinesForStations,
  FUEL_TYPE_TO_PRICE_FIELD,
  __setPoolForTests,
};

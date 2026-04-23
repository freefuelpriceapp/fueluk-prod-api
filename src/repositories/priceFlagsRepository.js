'use strict';

const { getPool } = require('../config/db');

/**
 * priceFlagsRepository.js — F6 (community price flags)
 * Thin DB layer over the price_flags table. Hashing of device_id happens
 * in the service layer; this module stores whatever hash it is given.
 */

const DEDUP_WINDOW_MIN = 60;

/**
 * Returns true if this device_hash has already flagged (station, fuel)
 * within the last DEDUP_WINDOW_MIN minutes.
 */
async function hasRecentFlagFromDevice({ stationId, fuelType, deviceHash }) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT 1 FROM price_flags
       WHERE station_id = $1
         AND fuel_type = $2
         AND device_hash = $3
         AND created_at >= NOW() - ($4 || ' minutes')::INTERVAL
       LIMIT 1`,
    [stationId, fuelType, deviceHash, String(DEDUP_WINDOW_MIN)],
  );
  return res.rowCount > 0;
}

async function insertFlag({ stationId, fuelType, deviceHash, reason }) {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO price_flags (station_id, fuel_type, device_hash, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [stationId, fuelType, deviceHash, reason],
  );
  return res.rows[0];
}

/**
 * Count distinct device_hash values flagging (station, fuel) in the last
 * `windowMin` minutes.
 */
async function countDistinctDevicesLastHour({ stationId, fuelType, windowMin = DEDUP_WINDOW_MIN }) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT COUNT(DISTINCT device_hash)::int AS n
       FROM price_flags
       WHERE station_id = $1
         AND fuel_type = $2
         AND created_at >= NOW() - ($3 || ' minutes')::INTERVAL`,
    [stationId, fuelType, String(windowMin)],
  );
  return res.rows[0] ? Number(res.rows[0].n) : 0;
}

const QUARANTINE_DURATION_HOURS = 2;

/**
 * Upsert a (station, fuel) into the community-quarantine table, extending
 * expires_at to `now + QUARANTINE_DURATION_HOURS`.
 */
async function upsertQuarantine({ stationId, fuelType, reason = 'community_flags' }) {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO price_flag_quarantine (station_id, fuel_type, quarantined_at, expires_at, reason)
     VALUES ($1, $2, NOW(), NOW() + ($3 || ' hours')::INTERVAL, $4)
     ON CONFLICT (station_id, fuel_type) DO UPDATE
       SET quarantined_at = NOW(),
           expires_at     = NOW() + ($3 || ' hours')::INTERVAL,
           reason         = EXCLUDED.reason
     RETURNING station_id, fuel_type, quarantined_at, expires_at`,
    [stationId, fuelType, String(QUARANTINE_DURATION_HOURS), reason],
  );
  return res.rows[0] || null;
}

/**
 * Is this (station, fuel) currently community-quarantined and not
 * superseded by a newer feed update?
 */
async function isQuarantined({ stationId, fuelType }) {
  const pool = getPool();
  const res = await pool.query(
    `SELECT q.quarantined_at, q.expires_at
       FROM price_flag_quarantine q
       LEFT JOIN stations s ON s.id = q.station_id
       WHERE q.station_id = $1 AND q.fuel_type = $2
         AND q.expires_at > NOW()
         AND (s.last_updated IS NULL OR s.last_updated <= q.quarantined_at)
       LIMIT 1`,
    [stationId, fuelType],
  );
  return res.rowCount > 0;
}

module.exports = {
  hasRecentFlagFromDevice,
  insertFlag,
  countDistinctDevicesLastHour,
  upsertQuarantine,
  isQuarantined,
  DEDUP_WINDOW_MIN,
  QUARANTINE_DURATION_HOURS,
};

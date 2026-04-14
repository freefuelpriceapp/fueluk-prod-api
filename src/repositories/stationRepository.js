'use strict';
const { getPool } = require('../config/db');

/**
 * stationRepository.js — Sprint 1
 * All queries go through the pg Pool. No mock data.
 * Queries use the stations table schema (schema.sql).
 */

async function getNearbyStations({ lat, lng, radiusKm = 5, fuel = 'petrol', limit = 20 }) {
  const pool = getPool();
  const radiusM = radiusKm * 1000;
  const fuelCol = fuel === 'diesel' ? 'diesel_price' : fuel === 'e10' ? 'e10_price' : 'petrol_price';
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, last_updated,
            ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) AS distance_m
      FROM stations
      WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
        AND ${fuelCol} IS NOT NULL
      ORDER BY ${fuelCol} ASC, distance_m ASC
      LIMIT $4`,
    [lat, lng, radiusM, limit]
  );
  return result.rows;
}

async function searchStations({ query, fuelType, limit = 20 }) {
  const pool = getPool();
  const params = [`%${query}%`, limit];
  let fuelFilter = '';
  if (fuelType === 'petrol') {
    fuelFilter = 'AND petrol_price IS NOT NULL';
  } else if (fuelType === 'diesel') {
    fuelFilter = 'AND diesel_price IS NOT NULL';
  } else if (fuelType === 'e10') {
    fuelFilter = 'AND e10_price IS NOT NULL';
  }
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, last_updated
      FROM stations
      WHERE (LOWER(name) LIKE LOWER($1)
          OR LOWER(address) LIKE LOWER($1)
          OR LOWER(brand) LIKE LOWER($1)
          OR LOWER(postcode) LIKE LOWER($1))
      ${fuelFilter}
      ORDER BY name ASC
      LIMIT $2`,
    params
  );
  return result.rows;
}

async function getStationById(id) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
        petrol_price, diesel_price, e10_price, last_updated
      FROM stations WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getLastUpdated() {
  const pool = getPool();
  const result = await pool.query(
    `SELECT MAX(last_updated) AS last_updated, COUNT(*) AS station_count FROM stations`
  );
  return result.rows[0];
}

module.exports = { getNearbyStations, searchStations, getStationById, getLastUpdated };

'use strict';
const { getPool } = require('../config/db');

/**
 * stationRepository.js — Sprint 1 + Sprint 10 search upgrade + Sprint 11 smart search + Sprint 12 brand filter
 * All queries go through the pg Pool. No mock data.
 */

function normalisePostcode(s) {
  const up = String(s).toUpperCase().replace(/\s+/g, '');
  if (up.length > 3) return up.slice(0, up.length - 3) + ' ' + up.slice(-3);
  return up;
}

function isPostcodeLike(s) {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d?[A-Z]{0,2}$/i.test(String(s).trim());
}

async function getNearbyStations({ lat, lng, radiusKm = 5, fuel = 'petrol', limit = 20, brand = null }) {
  const pool = getPool();
  const radiusM = radiusKm * 1000;
  const fuelCol = fuel === 'diesel' ? 'diesel_price' : fuel === 'e10' ? 'e10_price' : 'petrol_price';
  const params = [lat, lng, radiusM, limit];
  let brandFilter = '';
  if (brand) {
    params.push(brand);
    brandFilter = `AND LOWER(brand) = LOWER($${params.length})`;
  }
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, petrol_source, diesel_source, e10_source, last_updated,
            opening_hours, amenities, is_motorway, is_supermarket, temporary_closure, permanent_closure,
            super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types,
            ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) AS distance_m
      FROM stations
      WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
                -- Show ALL stations (never hide a station for missing price)
        ${brandFilter}
            ORDER BY ${fuelCol} ASC NULLS LAST, distance_m ASC
      LIMIT $4`,
    params
  );
  return result.rows;
}

async function searchStations({ query, fuelType, limit = 20 }) {
  const pool = getPool();
  const params = [`%${query}%`, limit];
  let fuelFilter = '';
  if (fuelType === 'petrol') fuelFilter = 'AND petrol_price IS NOT NULL';
  else if (fuelType === 'diesel') fuelFilter = 'AND diesel_price IS NOT NULL';
  else if (fuelType === 'e10') fuelFilter = 'AND e10_price IS NOT NULL';
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, petrol_source, diesel_source, e10_source, last_updated,
            opening_hours, amenities, is_motorway, is_supermarket, temporary_closure, permanent_closure,
            super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types
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

async function searchStationsTokens({ tokens, fuelType, limit = 20 }) {
  if (!tokens || !tokens.length) return [];
  const pool = getPool();
  const params = [];
  const clauses = tokens.map((t) => {
    params.push(`%${t.toLowerCase()}%`);
    const p = `$${params.length}`;
    return `(LOWER(name) LIKE ${p} OR LOWER(address) LIKE ${p} OR LOWER(brand) LIKE ${p} OR LOWER(postcode) LIKE ${p})`;
  }).join(' AND ');
  let fuelFilter = '';
  if (fuelType === 'petrol') fuelFilter = 'AND petrol_price IS NOT NULL';
  else if (fuelType === 'diesel') fuelFilter = 'AND diesel_price IS NOT NULL';
  else if (fuelType === 'e10') fuelFilter = 'AND e10_price IS NOT NULL';
  params.push(limit);
  const limitP = `$${params.length}`;
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, petrol_source, diesel_source, e10_source, last_updated,
            opening_hours, amenities, is_motorway, is_supermarket, temporary_closure, permanent_closure,
            super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types
      FROM stations
      WHERE ${clauses} ${fuelFilter}
      ORDER BY name ASC
      LIMIT ${limitP}`,
    params
  );
  return result.rows;
}

async function searchStationsSmart({ query, fuelType, limit = 20 }) {
  const pool = getPool();
  const raw = String(query || '').trim();
  if (!raw) return [];
  let fuelFilter = '';
  if (fuelType === 'petrol') fuelFilter = 'AND petrol_price IS NOT NULL';
  else if (fuelType === 'diesel') fuelFilter = 'AND diesel_price IS NOT NULL';
  else if (fuelType === 'e10') fuelFilter = 'AND e10_price IS NOT NULL';
  if (isPostcodeLike(raw)) {
    const full = normalisePostcode(raw);
    const compact = full.replace(/\s+/g, '');
    const district = full.split(' ')[0];
    const r = await pool.query(
      `SELECT id, brand, name, address, postcode, lat, lng,
              petrol_price, diesel_price, e10_price, petrol_source, diesel_source, e10_source, last_updated,
              opening_hours, amenities, is_motorway, is_supermarket, temporary_closure, permanent_closure,
              super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types
         FROM stations
        WHERE (UPPER(postcode) = $1
            OR REPLACE(UPPER(postcode),' ','') = $2
            OR UPPER(postcode) LIKE $3)
          ${fuelFilter}
        ORDER BY
          CASE WHEN UPPER(postcode)=$1 THEN 0
               WHEN REPLACE(UPPER(postcode),' ','')=$2 THEN 1
               ELSE 2 END,
          name ASC
        LIMIT $4`,
      [full, compact, district + '%', limit]
    );
    return r.rows;
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  return searchStationsTokens({ tokens, fuelType, limit });
}

async function getStationById(id) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
        petrol_price, diesel_price, e10_price, petrol_source, diesel_source, e10_source, last_updated,
        opening_hours, amenities, is_motorway, is_supermarket, temporary_closure, permanent_closure,
        super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types
      FROM stations WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getDistinctBrands() {
  const pool = getPool();
  const result = await pool.query(
    `SELECT DISTINCT brand FROM stations WHERE brand IS NOT NULL AND brand != '' ORDER BY brand ASC`
  );
  return result.rows.map(r => r.brand);
}

async function getLastUpdated() {
  const pool = getPool();
  const result = await pool.query(
    `SELECT MAX(last_updated) AS last_updated, COUNT(*) AS station_count FROM stations`
  );
  return result.rows[0];
}

module.exports = { getNearbyStations, searchStations, searchStationsTokens, searchStationsSmart, getStationById, getDistinctBrands, getLastUpdated, normalisePostcode, isPostcodeLike };

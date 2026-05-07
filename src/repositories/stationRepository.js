'use strict';
const { getPool } = require('../config/db');
const { normalizeBrandKey, canonicalBrandName, normalizedKeysForBrandFilter, BRAND_ALIASES } = require('../utils/brandNormalizer');

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

async function getNearbyStations({ lat, lng, radiusKm = 5, fuel = 'petrol', limit = 50, brand = null, orderBy = 'distance' }) {
  const pool = getPool();
  const radiusM = radiusKm * 1000;
  const fuelCol = fuel === 'diesel' ? 'diesel_price' : fuel === 'e10' ? 'e10_price' : 'petrol_price';
  const params = [lat, lng, radiusM, limit];
  let brandFilter = '';
  if (brand) {
    const keys = normalizedKeysForBrandFilter(brand);
    if (keys.length) {
      const placeholders = keys.map(k => {
        params.push(k);
        return `$${params.length}`;
      }).join(', ');
      brandFilter = `AND REGEXP_REPLACE(UPPER(brand), '[^A-Z0-9]', '', 'g') IN (${placeholders})`;
    }
  }
  // 'distance' (default) → closest first; 'price' → cheapest-for-fuel first, then closer tiebreak.
  const orderClause = orderBy === 'price'
    ? `${fuelCol} ASC NULLS LAST, distance_m ASC`
    : `distance_m ASC, ${fuelCol} ASC NULLS LAST`;
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, petrol_source, diesel_source, e10_source, last_updated,
            opening_hours, amenities, is_motorway, is_supermarket, temporary_closure, permanent_closure,
            super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types,
            petrol_updated_at, diesel_updated_at, e10_updated_at, super_unleaded_updated_at, premium_diesel_updated_at,
            ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) AS distance_m
      FROM stations
      WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
                -- Show ALL stations (never hide a station for missing price)
        AND name NOT LIKE 'QA %'
        AND name NOT LIKE 'Test %'
        AND (permanent_closure IS NOT TRUE)
        ${brandFilter}
            ORDER BY ${orderClause}
      LIMIT $4`,
    params
  );
  return result.rows;
}

async function searchStations({ query, fuelType, limit = 20, lat = null, lng = null }) {
  const pool = getPool();
  const params = [`%${query}%`];
  let fuelFilter = '';
  if (fuelType === 'petrol') fuelFilter = 'AND petrol_price IS NOT NULL';
  else if (fuelType === 'diesel') fuelFilter = 'AND diesel_price IS NOT NULL';
  else if (fuelType === 'e10') fuelFilter = 'AND e10_price IS NOT NULL';

  const hasCoords = lat != null && lng != null && !isNaN(Number(lat)) && !isNaN(Number(lng));
  let orderBy;
  let distanceSelect = '';
  if (hasCoords) {
    params.push(Number(lat));
    const latIdx = params.length;
    params.push(Number(lng));
    const lngIdx = params.length;
    distanceSelect = `, ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($${lngIdx},$${latIdx}),4326)::geography) AS distance_m`;
    orderBy = `ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($${lngIdx},$${latIdx}),4326)::geography) ASC`;
  } else {
    params.push(query);
    const qIdx = params.length;
    orderBy = `CASE WHEN LOWER(brand) = LOWER($${qIdx}) THEN 0 ELSE 1 END, name ASC`;
  }
  params.push(limit);
  const limitIdx = params.length;
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, petrol_source, diesel_source, e10_source, last_updated,
            opening_hours, amenities, is_motorway, is_supermarket, temporary_closure, permanent_closure,
            super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types,
            petrol_updated_at, diesel_updated_at, e10_updated_at, super_unleaded_updated_at, premium_diesel_updated_at
            ${distanceSelect}
      FROM stations
      WHERE (LOWER(name) LIKE LOWER($1)
          OR LOWER(address) LIKE LOWER($1)
          OR LOWER(brand) LIKE LOWER($1)
          OR LOWER(postcode) LIKE LOWER($1))
        AND name NOT LIKE 'QA %'
        AND name NOT LIKE 'Test %'
        AND (permanent_closure IS NOT TRUE)
      ${fuelFilter}
      ORDER BY ${orderBy}
      LIMIT $${limitIdx}`,
    params
  );
  return result.rows;
}

async function searchStationsTokens({ tokens, fuelType, limit = 20, lat = null, lng = null }) {
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

  const hasCoords = lat != null && lng != null && !isNaN(Number(lat)) && !isNaN(Number(lng));
  let orderBy;
  let distanceSelect = '';
  if (hasCoords) {
    params.push(Number(lat));
    const latIdx = params.length;
    params.push(Number(lng));
    const lngIdx = params.length;
    distanceSelect = `, ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($${lngIdx},$${latIdx}),4326)::geography) AS distance_m`;
    orderBy = `ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($${lngIdx},$${latIdx}),4326)::geography) ASC`;
  } else {
    const joined = tokens.join(' ');
    params.push(joined);
    const qIdx = params.length;
    orderBy = `CASE WHEN LOWER(brand) = LOWER($${qIdx}) THEN 0 ELSE 1 END, name ASC`;
  }
  params.push(limit);
  const limitP = `$${params.length}`;
  const result = await pool.query(
    `SELECT id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, petrol_source, diesel_source, e10_source, last_updated,
            opening_hours, amenities, is_motorway, is_supermarket, temporary_closure, permanent_closure,
            super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types,
            petrol_updated_at, diesel_updated_at, e10_updated_at, super_unleaded_updated_at, premium_diesel_updated_at
            ${distanceSelect}
      FROM stations
      WHERE ${clauses} ${fuelFilter}
        AND name NOT LIKE 'QA %'
        AND name NOT LIKE 'Test %'
        AND (permanent_closure IS NOT TRUE)
      ORDER BY ${orderBy}
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
              super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types,
            petrol_updated_at, diesel_updated_at, e10_updated_at, super_unleaded_updated_at, premium_diesel_updated_at
         FROM stations
        WHERE (UPPER(postcode) = $1
            OR REPLACE(UPPER(postcode),' ','') = $2
            OR UPPER(postcode) LIKE $3)
          AND name NOT LIKE 'QA %'
          AND name NOT LIKE 'Test %'
          AND (permanent_closure IS NOT TRUE)
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
        super_unleaded_price, super_unleaded_source, premium_diesel_price, premium_diesel_source, fuel_types,
        petrol_updated_at, diesel_updated_at, e10_updated_at, super_unleaded_updated_at, premium_diesel_updated_at
      FROM stations WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getDistinctBrands() {
  const pool = getPool();
  const result = await pool.query(
    `SELECT TRIM(brand) AS display_name, COUNT(*) AS station_count
     FROM stations
     WHERE brand IS NOT NULL
       AND TRIM(brand) != ''
       AND (permanent_closure IS NOT TRUE)
       AND name NOT LIKE 'QA %'
       AND name NOT LIKE 'Test %'
     GROUP BY display_name`
  );

  const merged = new Map();
  for (const row of result.rows) {
    const rawName = row.display_name;
    const count = parseInt(row.station_count, 10);
    const key = normalizeBrandKey(rawName);
    if (!key) continue;
    const aliasCanonical = BRAND_ALIASES[key];
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        name: aliasCanonical || rawName,
        count,
        topVariantCount: count,
        aliasLocked: Boolean(aliasCanonical),
      });
    } else {
      existing.count += count;
      if (!existing.aliasLocked && count > existing.topVariantCount) {
        existing.name = rawName;
        existing.topVariantCount = count;
      }
    }
  }

  const brands = [...merged.values()]
    .filter(b => b.count >= 3)
    .map(b => ({ name: b.name, count: b.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return brands;
}

async function getLastUpdated() {
  const pool = getPool();
  const result = await pool.query(
    `SELECT MAX(last_updated) AS last_updated, COUNT(*) AS station_count FROM stations`
  );
  return result.rows[0];
}

module.exports = { getNearbyStations, searchStations, searchStationsTokens, searchStationsSmart, getStationById, getDistinctBrands, getLastUpdated, normalisePostcode, isPostcodeLike };

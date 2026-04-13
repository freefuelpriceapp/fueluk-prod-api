'use strict';
const { getPool } = require('../config/db');

/**
 * priceRepository.js — Sprint 6
 * All queries go through the pg Pool.
 * Handles price_reports table for user-submitted and scraped fuel prices.
 */

/**
 * Get prices for a specific station, optionally filtered by fuel type
 */
async function getPricesByStation({ stationId, fuelType = null }) {
  const pool = getPool();
  let query = `
    SELECT
      pr.id,
      pr.station_id,
      pr.fuel_type,
      pr.price_pence,
      pr.source,
      pr.reported_at,
      s.name AS station_name,
      s.brand,
      s.address
    FROM price_reports pr
    JOIN stations s ON s.id = pr.station_id
    WHERE pr.station_id = $1
  `;
  const params = [stationId];

  if (fuelType) {
    query += ` AND pr.fuel_type = $${params.length + 1}`;
    params.push(fuelType);
  }

  query += ' ORDER BY pr.reported_at DESC LIMIT 50';

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Insert a new price report
 */
async function insertPrice({ stationId, fuelType, pricePence, source = 'user' }) {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO price_reports (station_id, fuel_type, price_pence, source, reported_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [stationId, fuelType, pricePence, source]
  );
  return result.rows[0];
}

/**
 * Get latest prices across all stations
 */
async function getLatestPrices({ fuelType = null, limit = 50 }) {
  const pool = getPool();
  let query = `
    SELECT DISTINCT ON (pr.station_id, pr.fuel_type)
      pr.id,
      pr.station_id,
      pr.fuel_type,
      pr.price_pence,
      pr.source,
      pr.reported_at,
      s.name AS station_name,
      s.brand,
      s.address,
      s.lat,
      s.lng
    FROM price_reports pr
    JOIN stations s ON s.id = pr.station_id
  `;
  const params = [];

  if (fuelType) {
    query += ` WHERE pr.fuel_type = $1`;
    params.push(fuelType);
  }

  query += ` ORDER BY pr.station_id, pr.fuel_type, pr.reported_at DESC
    LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await pool.query(query, params);
  return result.rows;
}

module.exports = { getPricesByStation, insertPrice, getLatestPrices };

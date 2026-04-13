'use strict';
const router = require('express').Router();
const { getPool } = require('../config/db');

// ─── Helper ────────────────────────────────────────────────────────────────────
const fuelColumn = (fuel) => {
  if (fuel === 'diesel') return 'diesel_price';
  if (fuel === 'e10') return 'e10_price';
  return 'petrol_price';
};

// ─── GET /api/v1/stations/nearby ───────────────────────────────────────────────
router.get('/nearby', async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.latitude);
    const lng = parseFloat(req.query.longitude);
    const radius = parseFloat(req.query.radius) || 5;
    const fuel = req.query.fuel || 'petrol';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'latitude and longitude are required numeric parameters' });
    }

    const fuelCol = fuelColumn(fuel);
    const radiusM = radius * 1000;
    const result = await getPool().query(
      `SELECT id, brand, name, address, postcode,
          lat, lng, petrol_price, diesel_price, e10_price,
          last_updated,
          ROUND((ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) / 1000)::numeric, 2) AS distance_km
       FROM stations
       WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
         AND ${fuelCol} IS NOT NULL
       ORDER BY ${fuelCol} ASC, distance_km ASC
       LIMIT $4`,
      [lat, lng, radiusM, limit]
    );

    res.json({
      count: result.rows.length,
      radiusKm: radius,
      fuel,
      stations: result.rows
    });
  } catch (err) { next(err); }
});

// ─── GET /api/v1/stations/cheapest ─────────────────────────────────────────────
// Returns cheapest stations nationally or within optional radius of lat/lng
router.get('/cheapest', async (req, res, next) => {
  try {
    const fuel = req.query.fuel || 'petrol';
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const lat = parseFloat(req.query.latitude);
    const lng = parseFloat(req.query.longitude);
    const radius = parseFloat(req.query.radius) || 50; // km

    const fuelCol = fuelColumn(fuel);

    let query, params;
    if (!isNaN(lat) && !isNaN(lng)) {
      const radiusM = radius * 1000;
      query = `SELECT id, brand, name, address, postcode,
          lat, lng, petrol_price, diesel_price, e10_price, last_updated,
          ROUND((ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) / 1000)::numeric, 2) AS distance_km
        FROM stations
        WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
          AND ${fuelCol} IS NOT NULL
        ORDER BY ${fuelCol} ASC
        LIMIT $4`;
      params = [lat, lng, radiusM, limit];
    } else {
      query = `SELECT id, brand, name, address, postcode,
          lat, lng, petrol_price, diesel_price, e10_price, last_updated
        FROM stations
        WHERE ${fuelCol} IS NOT NULL
        ORDER BY ${fuelCol} ASC
        LIMIT $1`;
      params = [limit];
    }

    const result = await getPool().query(query, params);
    res.json({
      count: result.rows.length,
      fuel,
      stations: result.rows
    });
  } catch (err) { next(err); }
});

// ─── GET /api/v1/stations/search ───────────────────────────────────────────────
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ error: 'q query parameter is required' });
    }
    const fuel = req.query.fuel || null;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    let fuelFilter = '';
    if (fuel) {
      const fuelCol = fuelColumn(fuel);
      fuelFilter = ` AND ${fuelCol} IS NOT NULL`;
    }

    const result = await getPool().query(
      `SELECT id, brand, name, address, postcode, lat, lng,
          petrol_price, diesel_price, e10_price, last_updated
       FROM stations
       WHERE (LOWER(name) LIKE LOWER($1)
          OR LOWER(address) LIKE LOWER($1)
          OR LOWER(brand) LIKE LOWER($1)
          OR LOWER(postcode) LIKE LOWER($1))${fuelFilter}
       ORDER BY name ASC
       LIMIT $2`,
      [`%${q}%`, limit]
    );
    res.json({ count: result.rows.length, query: q, stations: result.rows });
  } catch (err) { next(err); }
});

// ─── GET /api/v1/stations/:id ──────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const result = await getPool().query(
      `SELECT s.*, 
          COALESCE(
            (SELECT json_agg(json_build_object(
              'fuel_type', ph.fuel_type,
              'price_pence', ph.price_pence,
              'recorded_at', ph.recorded_at
            ) ORDER BY ph.recorded_at DESC)
            FROM price_history ph
            WHERE ph.station_id = s.id
              AND ph.recorded_at > NOW() - INTERVAL '7 days'
          ), '[]'::json) AS recent_history
       FROM stations s
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Station not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ─── GET /api/v1/stations ──────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const brand = req.query.brand;
    const fuel = req.query.fuel || null;
    let conditions = [];
    const params = [];

    if (brand) {
      params.push(brand);
      conditions.push(`LOWER(brand) = LOWER($${params.length})`);
    }
    if (fuel) {
      const fuelCol = fuelColumn(fuel);
      conditions.push(`${fuelCol} IS NOT NULL`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);
    const query = `SELECT id, brand, name, address, postcode, lat, lng,
        petrol_price, diesel_price, e10_price, last_updated
      FROM stations ${where}
      ORDER BY last_updated DESC LIMIT $${params.length}`;

    const result = await getPool().query(query, params);
    res.json({ count: result.rows.length, stations: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;

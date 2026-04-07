'use strict';
const router = require('express').Router();
const { getPool } = require('../config/db');

// GET /api/v1/stations/nearby?latitude=51.5&longitude=-0.1&radius=5&fuel=petrol&limit=20
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

    const fuelCol = fuel === 'diesel' ? 'diesel_price'
      : fuel === 'e10' ? 'e10_price'
      : 'petrol_price';

    const radiusM = radius * 1000;
    const result = await getPool().query(
      `SELECT id, brand, name, address, postcode,
        lat, lng, petrol_price, diesel_price, e10_price,
        last_updated,
        ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) AS distance_m
       FROM stations
       WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
         AND ${fuelCol} IS NOT NULL
       ORDER BY ${fuelCol} ASC, distance_m ASC
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

// GET /api/v1/stations/search?q=Potters
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ error: 'q query parameter is required' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const result = await getPool().query(
      `SELECT id, brand, name, address, postcode, lat, lng,
        petrol_price, diesel_price, e10_price, last_updated
       FROM stations
       WHERE LOWER(name) LIKE LOWER($1)
          OR LOWER(address) LIKE LOWER($1)
          OR LOWER(brand) LIKE LOWER($1)
          OR LOWER(postcode) LIKE LOWER($1)
       ORDER BY name ASC
       LIMIT $2`,
      [`%${q}%`, limit]
    );
    res.json({ count: result.rows.length, query: q, stations: result.rows });
  } catch (err) { next(err); }
});

// GET /api/v1/stations/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await getPool().query(
      'SELECT * FROM stations WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Station not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/v1/stations?brand=BP&limit=20
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const brand = req.query.brand;
    let query = 'SELECT id, brand, name, address, postcode, lat, lng, petrol_price, diesel_price, e10_price, last_updated FROM stations WHERE 1=1';
    const params = [];
    if (brand) { params.push(brand); query += ` AND LOWER(brand) = LOWER($${params.length})`; }
    params.push(limit);
    query += ` ORDER BY last_updated DESC LIMIT $${params.length}`;
    const result = await getPool().query(query, params);
    res.json({ count: result.rows.length, stations: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;

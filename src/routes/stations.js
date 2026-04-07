'use strict';
const router = require('express').Router();
const { getPool } = require('../config/db');

// GET /stations/nearby?lat=51.5&lng=-0.1&radius=5&fuel=petrol&limit=20
router.get('/nearby', async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseFloat(req.query.radius) || 5;
    const fuel = req.query.fuel || 'petrol';
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng are required numeric parameters' });
    }

    const fuelCol = fuel === 'diesel' ? 'diesel_price'
      : fuel === 'e10' ? 'e10_price'
      : 'petrol_price';

    const radiusM = radius * 1000;
    const result = await getPool().query(
      `SELECT id, brand, name, address, postcode,
        lat, lng, petrol_price, diesel_price, e10_price,
        amenities, last_updated,
        earth_distance(ll_to_earth($1,$2), ll_to_earth(lat,lng)) AS distance_m
       FROM stations
       WHERE earth_box(ll_to_earth($1,$2), $3) @> ll_to_earth(lat,lng)
         AND earth_distance(ll_to_earth($1,$2), ll_to_earth(lat,lng)) <= $3
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

// GET /stations/:id
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

// GET /stations?postcode=SW1A1AA&fuel=petrol
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

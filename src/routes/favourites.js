'use strict';
const router = require('express').Router();
const { getPool } = require('../config/db');

// ─── GET /api/v1/favourites ────────────────────────────────────────────────────
// Returns all favourite station IDs for a given device token
router.get('/', async (req, res, next) => {
  try {
    const deviceToken = req.headers['x-device-token'];
    if (!deviceToken) {
      return res.status(400).json({ error: 'x-device-token header is required' });
    }
    const result = await getPool().query(
      `SELECT s.id, s.brand, s.name, s.address, s.postcode,
          s.lat, s.lng, s.petrol_price, s.diesel_price, s.e10_price, s.last_updated
       FROM user_favourites uf
       JOIN stations s ON s.id = uf.station_id
       WHERE uf.device_token = $1
       ORDER BY uf.created_at DESC`,
      [deviceToken]
    );
    res.json({ count: result.rows.length, stations: result.rows });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/favourites ───────────────────────────────────────────────────
// Add a station to favourites for this device
router.post('/', async (req, res, next) => {
  try {
    const deviceToken = req.headers['x-device-token'];
    if (!deviceToken) {
      return res.status(400).json({ error: 'x-device-token header is required' });
    }
    const { station_id } = req.body;
    if (!station_id) {
      return res.status(400).json({ error: 'station_id is required' });
    }
    await getPool().query(
      `INSERT INTO user_favourites (device_token, station_id)
       VALUES ($1, $2)
       ON CONFLICT (device_token, station_id) DO NOTHING`,
      [deviceToken, station_id]
    );
    res.status(201).json({ success: true, station_id });
  } catch (err) { next(err); }
});

// ─── DELETE /api/v1/favourites/:stationId ─────────────────────────────────────
// Remove a station from favourites for this device
router.delete('/:stationId', async (req, res, next) => {
  try {
    const deviceToken = req.headers['x-device-token'];
    if (!deviceToken) {
      return res.status(400).json({ error: 'x-device-token header is required' });
    }
    await getPool().query(
      `DELETE FROM user_favourites WHERE device_token = $1 AND station_id = $2`,
      [deviceToken, req.params.stationId]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

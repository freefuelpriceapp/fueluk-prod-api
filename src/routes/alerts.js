'use strict';
/**
 * Sprint 3 — Price Alert Routes
 * POST /api/v1/alerts          — register a price alert
 * GET  /api/v1/alerts/:token   — get alerts by device token
 * DELETE /api/v1/alerts/:id    — delete a specific alert
 */
const router = require('express').Router();
const { getPool } = require('../config/db');

// POST /api/v1/alerts
// Body: { station_id, fuel_type, threshold_pence, device_token, platform }
router.post('/', async (req, res, next) => {
  try {
    const { station_id, fuel_type, threshold_pence, device_token, platform } = req.body;

    if (!station_id || !fuel_type || !threshold_pence || !device_token) {
      return res.status(400).json({
        error: 'station_id, fuel_type, threshold_pence, and device_token are required'
      });
    }

    if (!['petrol', 'diesel', 'e10'].includes(fuel_type)) {
      return res.status(400).json({ error: 'fuel_type must be petrol, diesel, or e10' });
    }

    const result = await getPool().query(
      `INSERT INTO price_alerts
         (station_id, fuel_type, threshold_pence, device_token, platform, active, created_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       ON CONFLICT (station_id, fuel_type, device_token)
         DO UPDATE SET threshold_pence = EXCLUDED.threshold_pence, active = true, updated_at = NOW()
       RETURNING *`,
      [station_id, fuel_type, threshold_pence, device_token, platform || 'unknown']
    );

    res.status(201).json({ alert: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/v1/alerts/:token — get all active alerts for a device token
router.get('/:token', async (req, res, next) => {
  try {
    const result = await getPool().query(
      `SELECT pa.*, s.name AS station_name, s.brand, s.address
       FROM price_alerts pa
       JOIN stations s ON s.id = pa.station_id
       WHERE pa.device_token = $1 AND pa.active = true
       ORDER BY pa.created_at DESC`,
      [req.params.token]
    );
    res.json({ count: result.rows.length, alerts: result.rows });
  } catch (err) { next(err); }
});

// DELETE /api/v1/alerts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await getPool().query(
      'UPDATE price_alerts SET active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json({ deleted: true, id: result.rows[0].id });
  } catch (err) { next(err); }
});

module.exports = router;

'use strict';
/**
 * Sprint 3 — Price Alert Routes
 * POST   /api/v1/alerts                — register a price alert
 * GET    /api/v1/alerts/:token         — get alerts by device token
 * DELETE /api/v1/alerts/:id            — delete a specific alert
 * DELETE /api/v1/alerts/token/:token   — delete ALL alerts for a device push token
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

    // Wave B (B-04): accept full fuel taxonomy (modern + legacy).
    // Modern: unleaded, super_unleaded, diesel, premium_diesel
    // Legacy: petrol/e10 → unleaded equivalents, e5 → super_unleaded; the alert
    // job translates these at evaluation time so they continue to fire.
    const ALLOWED_FUEL_TYPES = [
      'unleaded', 'super_unleaded', 'diesel', 'premium_diesel',
      'petrol', 'e10', 'e5',
    ];
    if (!ALLOWED_FUEL_TYPES.includes(fuel_type)) {
      return res.status(400).json({
        error: `fuel_type must be one of: ${ALLOWED_FUEL_TYPES.join(', ')}`,
      });
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

// DELETE /api/v1/alerts/token/:token — bulk delete all alerts for a device push token.
// Declared before DELETE /:id so the more-specific path matches first.
router.delete('/token/:token', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const result = await getPool().query(
      `UPDATE price_alerts
          SET active = false, updated_at = NOW()
        WHERE device_token = $1 AND active = true
        RETURNING id`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'No alerts found for that token' });
    }

    res.json({ success: true, deleted: result.rows.length });
  } catch (err) { next(err); }
});

// DELETE /api/v1/alerts/:id — delete a single alert by its numeric ID
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

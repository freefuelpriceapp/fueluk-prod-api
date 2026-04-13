'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../config/db');
const { isEnabled } = require('../utils/featureFlags');
const { runNow } = require('../jobs/ingestRunner');

/**
 * prices.js — Sprint 2 + Sprint 4 update
 * Routes:
 *   GET  /api/v1/prices/:stationId/history   — price trend for a station
 *   POST /api/v1/prices/ingest               — admin trigger (feature-flagged)
 */

/**
 * GET /api/v1/prices/:stationId/history
 * Returns hourly price snapshots for a given station.
 * Query params:
 *   days   (default 7)  — how many days of history to return (max 90)
 *   fuel   (default all) — filter to petrol | diesel | e10
 * Response shape:
 *   { stationId, days, fuel, count, history: [{recorded_at, fuel_type, price_pence}] }
 */
router.get('/:stationId/history', async (req, res, next) => {
  try {
    if (!isEnabled('nearby_stations')) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

    const { stationId } = req.params;
    const days = Math.min(parseInt(req.query.days ?? '7', 10), 90);
    const fuel = req.query.fuel || null; // petrol | diesel | e10 | null (all)

    const pool = getPool();

    // Build query — optionally filter by fuel_type
    const params = [stationId, days];
    let fuelFilter = '';
    if (fuel && ['petrol', 'diesel', 'e10'].includes(fuel)) {
      fuelFilter = ' AND fuel_type = $3';
      params.push(fuel);
    }

    const result = await pool.query(
      `SELECT
         recorded_at,
         fuel_type,
         price_pence
       FROM price_history
       WHERE station_id = $1
         AND recorded_at >= NOW() - INTERVAL '1 day' * $2
         ${fuelFilter}
       ORDER BY recorded_at ASC, fuel_type ASC`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'No price history found for this station',
        stationId,
      });
    }

    return res.json({
      stationId,
      days,
      fuel: fuel || 'all',
      count: result.rows.length,
      history: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/prices/ingest
 * Admin endpoint to manually trigger a full ingest cycle.
 * Requires ADMIN_TOKEN header matching the ADMIN_TOKEN env var.
 * Protected — not exposed in production without token.
 */
router.post('/ingest', async (req, res, next) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
      return res.status(401).json({ error: 'Unauthorised' });
    }

    const summary = await runNow();
    return res.json({ ok: true, summary });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

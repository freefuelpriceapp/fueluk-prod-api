'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../config/db');
const { isEnabled } = require('../utils/featureFlags');
const { runNow } = require('../jobs/ingestRunner');
const priceController = require('../controllers/priceController');

/**
 * prices.js — Sprint 2 + Sprint 4 + Sprint 6
 * Routes:
 *   GET  /api/v1/prices/:stationId/history   — price trend for a station
 *   POST /api/v1/prices/ingest               — admin trigger (feature-flagged)
 *   GET  /api/v1/prices/station/:stationId   — Sprint 6: prices by station
 *   POST /api/v1/prices                      — Sprint 6: submit a price report
 *   GET  /api/v1/prices/latest               — Sprint 6: latest prices all stations
 */

/**
 * GET /api/v1/prices/:stationId/history
 * Returns hourly price snapshots for a given station.
 * Query params:
 *   days  (default 7) – how many days of history to return (max 90)
 *   fuel  (default all) – filter to petrol | diesel | e10 | null (all)
 * Response shape:
 *   { stationId, days, fuel, count, history: [{recorded_at, fuel_type, price_pence}] }
 */
router.get('/:stationId/history', async (req, res, next) => {
  try {
    if (!isEnabled('nearby_stations')) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

    const { stationId } = req.params;
    const days = Math.min(parseInt(req.query.days ?? '30', 10), 90);
    // Accept ?fuel_type=... per Sprint 2 spec; keep ?fuel= as a back-compat alias.
    const fuel = req.query.fuel_type || req.query.fuel || null;

    const pool = getPool();

    // One row per (day, fuel_type) with the last-recorded price of the day.
    // DISTINCT ON keeps Postgres doing the grouping; no app-side de-dup needed.
    const params = [stationId, days];
    let fuelFilter = '';
    if (fuel) {
      fuelFilter = 'AND fuel_type = $3';
      params.push(fuel);
    }

    const result = await pool.query(
      `SELECT DISTINCT ON (day, fuel_type)
              to_char(date_trunc('day', recorded_at), 'YYYY-MM-DD') AS date,
              date_trunc('day', recorded_at) AS day,
              fuel_type,
              price_pence,
              COALESCE(source, 'gov') AS source
         FROM price_history
        WHERE station_id = $1
          AND recorded_at >= NOW() - INTERVAL '1 day' * $2
          ${fuelFilter}
        ORDER BY day DESC, fuel_type, recorded_at DESC`,
      params
    );

    const history = result.rows.map((r) => ({
      date: r.date,
      fuel_type: r.fuel_type,
      price_pence: r.price_pence == null ? null : Number(r.price_pence),
      source: r.source,
    }));

    // Spec: if a fuel_type is specified, omit fuel_type from each entry.
    const shapedHistory = fuel
      ? history.map(({ fuel_type, ...rest }) => rest)
      : history;

    return res.json({
      station_id: stationId,
      fuel_type: fuel || 'all',
      days,
      count: shapedHistory.length,
      history: shapedHistory,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/prices/ingest
 * Admin-only trigger to manually kick off ingest job (feature-flagged).
 */
router.post('/ingest', async (req, res, next) => {
  try {
    if (!isEnabled('manual_ingest')) {
      return res.status(503).json({ error: 'Feature not enabled' });
    }
    await runNow();
    return res.json({ success: true, message: 'Ingest triggered' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/prices/station/:stationId
 * Sprint 6: Get prices for a specific station
 */
router.get('/station/:stationId', priceController.getPricesByStation);

/**
 * POST /api/v1/prices
 * Sprint 6: Submit a new user price report
 */
router.post('/', priceController.submitPrice);

/**
 * GET /api/v1/prices/latest
 * Sprint 6: Get latest prices across all stations
 */
router.get('/latest', priceController.getLatestPrices);

module.exports = router;

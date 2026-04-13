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
    const days = Math.min(parseInt(req.query.days ?? '7', 10), 90);
    const fuel = req.query.fuel || null; // petrol | diesel | e10 | null (all)

    const pool = getPool();

    // Build query – optionally filter by fuel_type
    const params = [stationId, days];
    let fuelFilter = '';
    if (fuel) {
      fuelFilter = 'AND fuel_type = $3';
      params.push(fuel);
    }

    const result = await pool.query(
      `SELECT recorded_at, fuel_type, price_pence
         FROM price_history
        WHERE station_id = $1
          AND recorded_at >= NOW() - INTERVAL '1 day' * $2
          ${fuelFilter}
        ORDER BY recorded_at ASC`,
      params
    );

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

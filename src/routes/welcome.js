'use strict';

/**
 * welcome.js — Wave A.9
 *
 * POST /api/v1/welcome/savings-estimate
 *
 * Returns a personalised savings estimate for the welcome flow.
 * Three frames: loss | validating | regional
 *
 * Privacy contract:
 *   - Plate number MUST NOT be passed in the request body — mobile sends
 *     resolved make/model/fuel_type/mpg only.
 *   - lat/lon are truncated to 3 d.p. (≈111m) on arrival.
 *   - No PII is logged from this endpoint.
 *
 * Kill-switch: remote config flag `welcome_flow_enabled` (checked client-side).
 * Additional server-side guard: FEATURE_WELCOME_FLOW env var (default true).
 */

const router = require('express').Router();
const { computeSavingsEstimate } = require('../services/welcomeSavingsService');

/**
 * Truncate a number to N decimal places without rounding up.
 * Used to reduce lat/lon precision to ~111m (3 d.p.).
 */
function truncateCoord(val, dp = 3) {
  const factor = Math.pow(10, dp);
  return Math.trunc(Number(val) * factor) / factor;
}

/**
 * POST /api/v1/welcome/savings-estimate
 *
 * Body:
 *   { lat, lon, make?, model?, fuel_type?, mpg?, mileage_per_year? }
 *
 * NOTE: plate is intentionally NOT accepted here.
 */
router.post('/savings-estimate', async (req, res, next) => {
  try {
    // Server-side kill-switch (default ON)
    const featureEnabled = process.env.FEATURE_WELCOME_FLOW !== 'false';
    if (!featureEnabled) {
      return res.status(503).json({ error: 'Welcome flow temporarily unavailable' });
    }

    const { lat, lon, make, model, fuel_type, mpg, mileage_per_year } = req.body || {};

    // Validate required coords
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    if (!isFinite(latNum) || !isFinite(lonNum)) {
      return res.status(400).json({ error: 'lat and lon are required and must be numeric' });
    }
    if (latNum < 49 || latNum > 61 || lonNum < -8 || lonNum > 2) {
      return res.status(400).json({ error: 'Coordinates must be within the United Kingdom' });
    }

    // Truncate to 3 d.p. for privacy (≈111m grid)
    const safeLat = truncateCoord(latNum, 3);
    const safeLon = truncateCoord(lonNum, 3);

    // Sanitised log — no PII, no plate, truncated coords only
    console.log('[welcome/savings-estimate] request', {
      lat: safeLat,
      lon: safeLon,
      hasMake: !!make,
      hasModel: !!model,
      hasFuelType: !!fuel_type,
      hasMpg: !!mpg,
    });

    const estimate = await computeSavingsEstimate({
      lat: safeLat,
      lon: safeLon,
      make: make || null,
      model: model || null,
      fuel_type: fuel_type || null,
      mpg: mpg ? Number(mpg) : null,
      mileage_per_year: mileage_per_year ? Number(mileage_per_year) : null,
    });

    return res.json(estimate);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

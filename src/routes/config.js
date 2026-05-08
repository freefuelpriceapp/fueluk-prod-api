'use strict';

/**
 * config.js — Wave A.9
 *
 * GET /api/v1/config/flags
 *
 * Returns remotely-controllable feature flags for the mobile app.
 * All flags default to ON unless overridden via environment variables.
 *
 * Mobile app polls this endpoint on cold-start and caches for 1 hour.
 * This is the server-side kill-switch mechanism for Wave A.9 and future waves.
 *
 * Flag naming: snake_case, matching the mobile useRemoteConfig pattern.
 */

const router = require('express').Router();

router.get('/flags', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour client-side cache

  const flags = {
    // Wave A.9 — welcome flow kill-switch (default ON)
    welcome_flow_enabled: process.env.FEATURE_WELCOME_FLOW !== 'false',

    // Hook Strategy v1 future flags (defaulted OFF until shipped)
    // detour_intelligence: false,
    // wait_or_fill_predictor: false,
    // fuel_facts: false,
    // driver_pnl: false,
  };

  return res.json(flags);
});

module.exports = router;

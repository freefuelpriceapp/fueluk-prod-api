'use strict';

/**
 * Feature Flag System — Sprint 1
 * All non-MVP features are DISABLED by default.
 * Enable via environment variables when ready.
 * Never activate: community_reports, route_intelligence,
 * rewards_system, price_alerts, premium_tier in launch builds.
 */

const FLAGS = {
  // ── MVP features (always enabled) ──────────────────────
  nearby_stations:     true,
  station_search:      true,
  station_detail:      true,
  fuel_freshness:      true,
  favourites_local:    true,

  // ── Sprint 4 — disabled until moderation tools ready ───
  price_alerts:        env('FEATURE_PRICE_ALERTS',        false),
  community_reports:   env('FEATURE_COMMUNITY_REPORTS',   false),

  // ── Sprint 5 — disabled, route intelligence ─────────────
  route_intelligence:  env('FEATURE_ROUTE_INTELLIGENCE',  false),

  // ── Sprint 6 — disabled, rewards & contribution ────────
  rewards_system:      env('FEATURE_REWARDS',             false),

  // ── Sprint 7 — disabled, premium subscription ──────────
  premium_tier:        env('FEATURE_PREMIUM',             false),

  // ── Future — disabled, monetization ────────────────────
  monetization:        env('FEATURE_MONETIZATION',        false),
};

function env(key, defaultVal) {
  const val = process.env[key];
  if (val === undefined || val === null) return defaultVal;
  return val === 'true' || val === '1';
}

function isEnabled(flag) {
  if (!(flag in FLAGS)) {
    console.warn(`[FeatureFlags] Unknown flag: ${flag}`);
    return false;
  }
  return FLAGS[flag] === true;
}

function getAll() {
  return { ...FLAGS };
}

module.exports = { isEnabled, getAll, FLAGS };

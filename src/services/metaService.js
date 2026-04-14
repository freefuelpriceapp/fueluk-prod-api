'use strict';

const metaRepository = require('../repositories/metaRepository');

/**
 * metaService.js
 * Business logic for API freshness, version status, and data trust signals.
 * Sprint 8 — service layer for meta/freshness endpoints.
 */

/**
 * Get the last-updated timestamp for all stations or a specific brand.
 * Used by the app to show data freshness trust cues.
 */
async function getLastUpdated() {
  const result = await metaRepository.getLastUpdated();
  if (!result) {
    return {
      last_updated: null,
      station_count: 0,
      freshness_status: 'unknown',
      message: 'No data ingested yet.',
    };
  }

  const ageMinutes = result.last_updated
    ? Math.floor((Date.now() - new Date(result.last_updated).getTime()) / 60000)
    : null;

  let freshness_status = 'fresh';
  if (ageMinutes === null) freshness_status = 'unknown';
  else if (ageMinutes > 240) freshness_status = 'stale';   // older than 4 hours
  else if (ageMinutes > 120) freshness_status = 'ageing'; // older than 2 hours

  return {
    last_updated: result.last_updated,
    station_count: parseInt(result.station_count, 10) || 0,
    freshness_status,
    age_minutes: ageMinutes,
    message: freshness_status === 'fresh'
      ? 'Prices are up to date.'
      : freshness_status === 'ageing'
        ? 'Prices may be slightly out of date.'
        : 'Prices may not reflect the latest pump prices.',
  };
}

/**
 * Get API version and dependency status.
 * Used by health/status endpoints and monitoring.
 */
function getApiStatus() {
  return {
    api: 'fueluk-prod-api',
    version: process.env.npm_package_version || '8.0.0',
    environment: process.env.NODE_ENV || 'production',
    status: 'ok',
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getLastUpdated,
  getApiStatus,
};

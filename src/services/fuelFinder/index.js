'use strict';
const cron = require('node-cron');
const { createTokenManager } = require('./tokenManager');
const { createApiClient } = require('./apiClient');
const { syncStations } = require('./stationSync');
const { syncPrices } = require('./priceSync');

/**
 * Fuel Finder entry point.
 *
 * Owns the long-lived token manager + API client, schedules:
 *   - Station sync: daily (default 03:15 Europe/London)
 *   - Price sync:  every 5 minutes
 *
 * Disabled by default — enable by setting FEATURE_FUEL_FINDER=true and
 * providing FUEL_FINDER_CLIENT_ID / FUEL_FINDER_CLIENT_SECRET. Disabling
 * keeps the existing CMA-brand + scraped feeds as the sole source of
 * truth until we validate the new data.
 */

const DEFAULT_STATION_CRON = '15 3 * * *'; // 03:15 daily
const DEFAULT_PRICE_CRON = '*/5 * * * *';  // every 5 min

let stationsJob = null;
let pricesJob = null;
let runningStations = false;
let runningPrices = false;
let apiClient = null;

function isFlagEnabled() {
  const v = process.env.FEATURE_FUEL_FINDER;
  return v === 'true' || v === '1';
}

function hasCredentials() {
  return !!(process.env.FUEL_FINDER_CLIENT_ID && process.env.FUEL_FINDER_CLIENT_SECRET);
}

function getApiClient() {
  if (!apiClient) {
    const tokenManager = createTokenManager();
    apiClient = createApiClient({ tokenManager });
  }
  return apiClient;
}

async function runStationSyncOnce() {
  if (runningStations) {
    console.warn('[FuelFinder] Station sync already running — skipping overlap');
    return { skipped: true };
  }
  runningStations = true;
  try {
    return await syncStations({ apiClient: getApiClient() });
  } catch (err) {
    console.error('[FuelFinder] Station sync errored:', err.message);
    return { error: err.message };
  } finally {
    runningStations = false;
  }
}

async function runPriceSyncOnce() {
  if (runningPrices) {
    console.warn('[FuelFinder] Price sync already running — skipping overlap');
    return { skipped: true };
  }
  runningPrices = true;
  try {
    return await syncPrices({ apiClient: getApiClient() });
  } catch (err) {
    console.error('[FuelFinder] Price sync errored:', err.message);
    return { error: err.message };
  } finally {
    runningPrices = false;
  }
}

function scheduleFuelFinder() {
  if (!isFlagEnabled()) {
    console.log('[FuelFinder] Disabled (FEATURE_FUEL_FINDER != true) — skipping schedule');
    return { enabled: false };
  }
  if (!hasCredentials()) {
    console.warn('[FuelFinder] Missing credentials — not scheduling');
    return { enabled: false, reason: 'missing_credentials' };
  }

  const stationCron = process.env.FUEL_FINDER_STATION_CRON || DEFAULT_STATION_CRON;
  const priceCron = process.env.FUEL_FINDER_PRICE_CRON || DEFAULT_PRICE_CRON;

  stationsJob = cron.schedule(stationCron, () => {
    runStationSyncOnce().catch((err) => console.error('[FuelFinder] cron station err:', err.message));
  }, { timezone: 'Europe/London' });

  pricesJob = cron.schedule(priceCron, () => {
    runPriceSyncOnce().catch((err) => console.error('[FuelFinder] cron price err:', err.message));
  }, { timezone: 'Europe/London' });

  console.log(`[FuelFinder] Scheduled: stations="${stationCron}", prices="${priceCron}"`);

  if (process.env.FUEL_FINDER_RUN_ON_BOOT === 'true') {
    runStationSyncOnce().catch((err) => console.error('[FuelFinder] boot station err:', err.message));
    setTimeout(() => {
      runPriceSyncOnce().catch((err) => console.error('[FuelFinder] boot price err:', err.message));
    }, 3 * 60 * 1000);
  }

  return { enabled: true, stationCron, priceCron };
}

function stopFuelFinder() {
  if (stationsJob) { stationsJob.stop(); stationsJob = null; }
  if (pricesJob) { pricesJob.stop(); pricesJob = null; }
}

module.exports = {
  scheduleFuelFinder,
  stopFuelFinder,
  runStationSyncOnce,
  runPriceSyncOnce,
  isFlagEnabled,
  hasCredentials,
};

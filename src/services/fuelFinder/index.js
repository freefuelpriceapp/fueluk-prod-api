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
    const summary = await syncStations({ apiClient: getApiClient() });
    return { ok: true, summary };
  } catch (err) {
    const detail = serialiseError(err);
    console.error('[FuelFinder] Station sync errored:', JSON.stringify(detail));
    return { ok: false, error: detail };
  } finally {
    runningStations = false;
  }
}

/**
 * Serialise an arbitrary error (including axios errors) into a structured
 * shape we can return over HTTP for diagnostics. Captures the upstream
 * status + response body when present so we can see WHY Fuel Finder is
 * rejecting us, not just "Network Error".
 */
function serialiseError(err) {
  if (!err) return { message: 'unknown' };
  const out = {
    message: err.message || String(err),
    name: err.name || null,
    code: err.code || null,
  };
  if (err.response) {
    out.upstream = {
      status: err.response.status,
      statusText: err.response.statusText,
      // Truncate body so we don't dump 10MB of HTML in the response.
      body: typeof err.response.data === 'string'
        ? err.response.data.slice(0, 2000)
        : err.response.data,
      headers: err.response.headers ? {
        'content-type': err.response.headers['content-type'] || null,
        'www-authenticate': err.response.headers['www-authenticate'] || null,
      } : null,
    };
  }
  if (err.config) {
    out.request = {
      method: err.config.method,
      url: err.config.url,
      params: err.config.params || null,
    };
  }
  return out;
}

async function runPriceSyncOnce() {
  if (runningPrices) {
    console.warn('[FuelFinder] Price sync already running — skipping overlap');
    return { skipped: true };
  }
  runningPrices = true;
  try {
    const summary = await syncPrices({ apiClient: getApiClient() });
    return { ok: true, summary };
  } catch (err) {
    const detail = serialiseError(err);
    console.error('[FuelFinder] Price sync errored:', JSON.stringify(detail));
    return { ok: false, error: detail };
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
    setTimeout(async () => {
      try {
        const { getPool } = require('../../config/db');
        await getPool().query('UPDATE fuel_finder_sync_state SET last_price_effective_ts = NULL WHERE id = 1');
        console.log('[FuelFinder] Reset price sync state for full boot fetch');
      } catch (e) {
        console.error('[FuelFinder] Could not reset price sync state:', e.message);
      }
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
  serialiseError,
};

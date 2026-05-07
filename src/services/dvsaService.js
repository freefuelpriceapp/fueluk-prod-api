'use strict';

/**
 * dvsaService.js
 * Wrapper around the DVSA MOT History Trade API.
 *
 * Production DVSA flow uses OAuth 2.0 client_credentials against Microsoft
 * Entra ID + a per-tenant `X-API-Key`. We cache the bearer in-process and
 * refresh ~60s before expiry; on a 401 we invalidate and retry once.
 *
 * Env vars (all required for the OAuth flow):
 *   DVSA_CLIENT_ID
 *   DVSA_CLIENT_SECRET
 *   DVSA_API_KEY
 *   DVSA_TOKEN_URL
 *   DVSA_SCOPE       (default: https://tapi.dvsa.gov.uk/.default)
 *   DVSA_API_BASE    (default: https://history.mot.api.gov.uk/v1/trade)
 *
 * Back-compat: `fetchMotHistory(reg)` is preserved for existing callers
 * (e.g. vehicleCheckService) and now goes through the OAuth flow. If the
 * legacy single-key env var DVSA_MOT_API_KEY is set without OAuth creds we
 * still report `isConfigured()` false to force the call through the new path
 * — the legacy x-api-key-only DVSA endpoint is being retired.
 */

const DEFAULT_API_BASE = 'https://history.mot.api.gov.uk/v1/trade';
const DEFAULT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';
const DEFAULT_TIMEOUT_MS = 8000;
// Refresh proactively at ~80% of the token lifetime. DVSA tokens last ~3600s,
// so REFRESH_SKEW_MS = 720s means we refresh once <12 min remain. This avoids
// edge cases where 60s skew would still let an in-flight call see a 401.
const REFRESH_SKEW_MS = 12 * 60 * 1000;
// 24h negative cache for confirmed-not-in-DVSA-DB results. Re-querying for a
// reg the API just told us doesn't exist wastes our daily quota.
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_MAX_ENTRIES = 5000;
// Retry budget for transient 429/5xx — exponential backoff with jitter.
const RETRY_5XX_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

// In-process counters for diagnostics. Reset by _resetMetricsForTests().
const metrics = {
  windowStartedAt: Date.now(),
  calls: 0,
  errors: 0,
  notFound: 0,
  tokenFetches: 0,
  tokenCacheHits: 0,
  tokenCacheMisses: 0,
};

function _recordCall() { metrics.calls += 1; }
function _recordError() { metrics.errors += 1; }
function _recordNotFound() { metrics.notFound += 1; }
function _recordTokenHit() { metrics.tokenCacheHits += 1; }
function _recordTokenMiss() { metrics.tokenCacheMisses += 1; metrics.tokenFetches += 1; }

function _resetMetricsForTests() {
  metrics.windowStartedAt = Date.now();
  metrics.calls = 0;
  metrics.errors = 0;
  metrics.notFound = 0;
  metrics.tokenFetches = 0;
  metrics.tokenCacheHits = 0;
  metrics.tokenCacheMisses = 0;
}

function getMetricsSnapshot() {
  const total = metrics.tokenCacheHits + metrics.tokenCacheMisses;
  const hitRate = total > 0 ? metrics.tokenCacheHits / total : null;
  return {
    last_24h_calls: metrics.calls,
    last_24h_errors: metrics.errors,
    last_24h_not_found: metrics.notFound,
    token_fetches: metrics.tokenFetches,
    token_cache_hit_rate: hitRate,
    window_started_at: new Date(metrics.windowStartedAt).toISOString(),
  };
}

// Negative cache: reg -> expiresAt. We only store 404s (no_results); transient
// 5xx results are NOT cached so the next request can recover.
const negativeCache = new Map();

function negCacheGet(reg) {
  const entry = negativeCache.get(reg);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    negativeCache.delete(reg);
    return null;
  }
  return entry;
}

function negCacheSet(reg) {
  if (negativeCache.has(reg)) negativeCache.delete(reg);
  negativeCache.set(reg, { expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS });
  while (negativeCache.size > NEGATIVE_CACHE_MAX_ENTRIES) {
    const oldest = negativeCache.keys().next().value;
    negativeCache.delete(oldest);
  }
}

function clearNegativeCache() { negativeCache.clear(); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isConfigured() {
  return Boolean(
    process.env.DVSA_CLIENT_ID
      && process.env.DVSA_CLIENT_SECRET
      && process.env.DVSA_API_KEY
      && process.env.DVSA_TOKEN_URL,
  );
}

function getApiBase() {
  return process.env.DVSA_API_BASE || DEFAULT_API_BASE;
}

function getScope() {
  return process.env.DVSA_SCOPE || DEFAULT_SCOPE;
}

function normaliseReg(reg) {
  return String(reg || '').replace(/\s+/g, '').toUpperCase();
}

function createTokenManager({
  clientId = process.env.DVSA_CLIENT_ID,
  clientSecret = process.env.DVSA_CLIENT_SECRET,
  tokenUrl = process.env.DVSA_TOKEN_URL,
  scope = getScope(),
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let accessToken = null;
  let expiresAtMs = 0;
  let inFlight = null;

  function isValid() {
    return Boolean(accessToken) && now() + REFRESH_SKEW_MS < expiresAtMs;
  }

  function invalidate() {
    accessToken = null;
    expiresAtMs = 0;
  }

  async function fetchToken() {
    if (!clientId || !clientSecret || !tokenUrl) {
      throw new Error('DVSA OAuth credentials not configured');
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        err && err.name === 'AbortError'
          ? 'DVSA token request timeout'
          : `DVSA token request failed: ${err.message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DVSA token endpoint ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    if (!json || !json.access_token) {
      throw new Error('DVSA token response missing access_token');
    }
    accessToken = json.access_token;
    const expiresInSec = Number(json.expires_in) || 3600;
    expiresAtMs = now() + expiresInSec * 1000;
    return accessToken;
  }

  async function getAccessToken() {
    if (isValid()) {
      _recordTokenHit();
      return accessToken;
    }
    if (inFlight) return inFlight;
    _recordTokenMiss();
    inFlight = fetchToken().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    getAccessToken,
    invalidate,
    _state: () => ({ accessToken, expiresAtMs }),
  };
}

// Module-level default token manager, used by getMotHistory / fetchMotHistory.
const defaultTokenManager = createTokenManager();

async function getAccessToken() {
  return defaultTokenManager.getAccessToken();
}

function invalidateToken() {
  defaultTokenManager.invalidate();
}

/**
 * Calls the DVSA Trade API to fetch MOT history for a single registration.
 * Returns a structured object on success or `{ found: false }` for 404.
 * Throws a structured Error on transport / 4xx / 5xx (except 404).
 *
 * @param {string} registration
 * @param {object} [opts]
 * @param {(input: any, init?: any) => Promise<any>} [opts.fetchImpl]
 * @param {object} [opts.tokenManager]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts._retried] internal — set on 401 retry
 */
async function getMotHistory(registration, opts = {}) {
  const reg = normaliseReg(registration);
  if (!reg) throw new Error('registration is required');

  // 24h negative cache for 404 (no_results). Skip with opts.skipNegativeCache.
  if (!opts.skipNegativeCache && negCacheGet(reg)) {
    _recordCall();
    _recordNotFound();
    return { found: false, cached: 'negative' };
  }

  const fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
  const tokenManager = opts.tokenManager || defaultTokenManager;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : RETRY_5XX_MAX_ATTEMPTS;

  _recordCall();

  const url = `${getApiBase()}/vehicles/registration/${encodeURIComponent(reg)}`;

  let attempt = 0;
  let tokenAlreadyRefreshed = Boolean(opts._retried);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    const token = await tokenManager.getAccessToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-API-Key': process.env.DVSA_API_KEY,
          Accept: 'application/json+v6',
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        _recordError();
        const e = new Error('DVSA API timeout');
        e.code = 'DVSA_TIMEOUT';
        throw e;
      }
      _recordError();
      const e = new Error(`DVSA API request failed: ${err.message}`);
      e.code = 'DVSA_NETWORK';
      throw e;
    }
    clearTimeout(timer);

    if (res.status === 404) {
      _recordNotFound();
      negCacheSet(reg);
      return { found: false };
    }
    if (res.status === 401 && !tokenAlreadyRefreshed) {
      tokenManager.invalidate();
      tokenAlreadyRefreshed = true;
      continue;
    }
    if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt < maxAttempts) {
      // Exponential backoff with jitter: 250ms, 500ms, 1s ...
      const base = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * RETRY_BASE_MS);
      await sleep(base + jitter);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      _recordError();
      const e = new Error(`DVSA API ${res.status}: ${text.slice(0, 200)}`);
      e.code = 'DVSA_HTTP';
      e.status = res.status;
      throw e;
    }

    const json = await res.json();
    return parseMotResponse(json, reg);
  }
}

/**
 * Normalises the DVSA response into our public schema. The API has returned
 * either a single object or a one-element array historically; handle both.
 */
function parseMotResponse(raw, reg) {
  const vehicle = Array.isArray(raw) ? raw[0] : raw;
  if (!vehicle) return { found: false };

  const tests = Array.isArray(vehicle.motTests) ? vehicle.motTests : [];
  return {
    found: true,
    registration: vehicle.registration || reg,
    make: vehicle.make || null,
    model: vehicle.model || null,
    firstUsedDate: vehicle.firstUsedDate || null,
    fuelType: vehicle.fuelType || null,
    primaryColour: vehicle.primaryColour || null,
    motTests: tests.map((t) => ({
      completedDate: t.completedDate || null,
      testResult: t.testResult || null,
      expiryDate: t.expiryDate || null,
      odometerValue: t.odometerValue != null ? Number(t.odometerValue) : null,
      odometerUnit: t.odometerUnit || null,
      motTestNumber: t.motTestNumber || null,
      // DVSA v6: defects — we expose them as rfrAndComments for forward
      // compatibility with the older payload shape some consumers expect.
      rfrAndComments: Array.isArray(t.defects)
        ? t.defects.map((d) => ({
            text: d.text || null,
            type: d.type || null,
            dangerous: Boolean(d.dangerous),
          }))
        : Array.isArray(t.rfrAndComments)
          ? t.rfrAndComments.map((d) => ({
              text: d.text || null,
              type: d.type || null,
              dangerous: Boolean(d.dangerous),
            }))
          : [],
    })),
  };
}

/**
 * Back-compat envelope for the orchestrator (vehicleCheckService).
 * Wraps getMotHistory in `{ available, data, error, notFound }` so existing
 * call sites don't need to change.
 */
async function fetchMotHistory(reg, opts = {}) {
  if (!isConfigured()) {
    return {
      available: false,
      data: null,
      error: 'DVSA OAuth credentials not configured',
    };
  }
  try {
    const result = await getMotHistory(reg, opts);
    if (result && result.found === false) {
      return { available: true, data: null, notFound: true, error: null };
    }
    // Map back to the legacy shape: an array containing a vehicle with motTests
    // mirroring what the v1/x-api-key-only API used to return, so mapMotHistory
    // in vehicleCheckService keeps working without modification.
    const legacy = [{
      registration: result.registration,
      make: result.make,
      model: result.model,
      firstUsedDate: result.firstUsedDate,
      fuelType: result.fuelType,
      primaryColour: result.primaryColour,
      motTests: result.motTests.map((t) => ({
        completedDate: t.completedDate,
        testResult: t.testResult,
        expiryDate: t.expiryDate,
        odometerValue: t.odometerValue,
        odometerUnit: t.odometerUnit,
        motTestNumber: t.motTestNumber,
        defects: t.rfrAndComments,
      })),
    }];
    return { available: true, data: legacy, error: null };
  } catch (err) {
    return {
      available: false,
      data: null,
      error: err.message || 'DVSA API error',
    };
  }
}

module.exports = {
  isConfigured,
  normaliseReg,
  getAccessToken,
  invalidateToken,
  getMotHistory,
  parseMotResponse,
  fetchMotHistory,
  createTokenManager,
  getMetricsSnapshot,
  clearNegativeCache,
  _resetMetricsForTests,
  DEFAULT_API_BASE,
  DEFAULT_SCOPE,
  NEGATIVE_CACHE_TTL_MS,
  RETRY_5XX_MAX_ATTEMPTS,
};

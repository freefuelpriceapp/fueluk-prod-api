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
const REFRESH_SKEW_MS = 60 * 1000;

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
    if (isValid()) return accessToken;
    if (inFlight) return inFlight;
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

  const fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
  const tokenManager = opts.tokenManager || defaultTokenManager;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const token = await tokenManager.getAccessToken();
  const url = `${getApiBase()}/vehicles/registration/${encodeURIComponent(reg)}`;

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
    if (err && err.name === 'AbortError') {
      const e = new Error('DVSA API timeout');
      e.code = 'DVSA_TIMEOUT';
      throw e;
    }
    const e = new Error(`DVSA API request failed: ${err.message}`);
    e.code = 'DVSA_NETWORK';
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) return { found: false };
  if (res.status === 401 && !opts._retried) {
    tokenManager.invalidate();
    return getMotHistory(registration, { ...opts, _retried: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`DVSA API ${res.status}: ${text.slice(0, 200)}`);
    e.code = 'DVSA_HTTP';
    e.status = res.status;
    throw e;
  }

  const json = await res.json();
  return parseMotResponse(json, reg);
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
  DEFAULT_API_BASE,
  DEFAULT_SCOPE,
};

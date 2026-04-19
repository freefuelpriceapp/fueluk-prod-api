'use strict';
const axios = require('axios');

/**
 * Fuel Finder OAuth token manager.
 *
 * The UK Gov Fuel Finder API issues short-lived (1h) access tokens via
 * /oauth/generate_access_token and lets you refresh them without
 * re-presenting the client_secret via /oauth/regenerate_access_token.
 *
 * This module caches the active token in-process, proactively refreshes a
 * minute before expiry, and falls back to a fresh generate_access_token if
 * refresh fails.
 */

const DEFAULT_BASE_URL = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_PATH = '/api/v1/oauth/generate_access_token';
const REFRESH_PATH = '/api/v1/oauth/regenerate_access_token';
// Refresh this many ms before expiry so we never send an expired bearer.
const REFRESH_SKEW_MS = 60 * 1000;

function createTokenManager({
  clientId = process.env.FUEL_FINDER_CLIENT_ID,
  clientSecret = process.env.FUEL_FINDER_CLIENT_SECRET,
  baseUrl = process.env.FUEL_FINDER_BASE_URL || DEFAULT_BASE_URL,
  httpClient = axios,
  now = () => Date.now(),
} = {}) {
  let accessToken = null;
  let refreshToken = null;
  let expiresAtMs = 0;
  let inFlight = null;

  function isValid() {
    return !!accessToken && now() + REFRESH_SKEW_MS < expiresAtMs;
  }

  function applyTokenResponse(data) {
    if (!data || !data.access_token) {
      throw new Error('Fuel Finder token response missing access_token');
    }
    accessToken = data.access_token;
    refreshToken = data.refresh_token || refreshToken;
    const expiresInSec = Number(data.expires_in) || 3600;
    expiresAtMs = now() + expiresInSec * 1000;
    return accessToken;
  }

  async function generate() {
    if (!clientId || !clientSecret) {
      throw new Error('Fuel Finder credentials not configured (FUEL_FINDER_CLIENT_ID / FUEL_FINDER_CLIENT_SECRET)');
    }
    const resp = await httpClient.post(
      `${baseUrl}${TOKEN_PATH}`,
      { client_id: clientId, client_secret: clientSecret },
      { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
    );
    const body = resp.data && (resp.data.data || resp.data);
    return applyTokenResponse(body);
  }

  async function refresh() {
    if (!refreshToken) return generate();
    try {
      const resp = await httpClient.post(
        `${baseUrl}${REFRESH_PATH}`,
        { client_id: clientId, refresh_token: refreshToken },
        { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
      );
      const body = resp.data && (resp.data.data || resp.data);
      return applyTokenResponse(body);
    } catch (err) {
      // Refresh path expired or invalid — fall back to a fresh generate.
      return generate();
    }
  }

  async function getToken() {
    if (isValid()) return accessToken;
    if (inFlight) return inFlight;
    inFlight = (refreshToken ? refresh() : generate())
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function invalidate() {
    accessToken = null;
    expiresAtMs = 0;
  }

  return { getToken, invalidate, _state: () => ({ accessToken, refreshToken, expiresAtMs }) };
}

module.exports = { createTokenManager };

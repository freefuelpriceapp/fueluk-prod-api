'use strict';
const axios = require('axios');

/**
 * Thin HTTP wrapper around the UK Gov Fuel Finder API.
 *
 * Handles bearer auth via a token manager, 401 re-authentication,
 * transient-error retries with backoff, and a client-side rate limit
 * (120 rpm / 10k rpd, with the docs recommending a 5s delay between
 * batch requests).
 *
 * The Fuel Finder API blocks non-UK datacenter IPs. When FUEL_FINDER_PROXY_URL
 * is set, all station/price requests are routed through a UK-based Lambda
 * proxy. Proxy routes are /stations and /prices (vs. /api/v1/pfs[...]
 * upstream) and require an x-proxy-secret header.
 */

const DEFAULT_BASE_URL = 'https://www.fuel-finder.service.gov.uk';
const STATIONS_PATH = '/api/v1/pfs';
const PRICES_PATH = '/api/v1/pfs/fuel-prices';
const PROXY_STATIONS_PATH = '/stations';
const PROXY_PRICES_PATH = '/prices';

// Fuel Finder docs: 120 req/min, 10k req/day, recommended 5s between batches.
const DEFAULT_REQUEST_DELAY_MS = 5000;
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  if (!err) return false;
  if (err.response) {
    const s = err.response.status;
    return s === 429 || (s >= 500 && s < 600);
  }
  // Network / timeout errors
  return ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code);
}

function createApiClient({
  tokenManager,
  baseUrl = process.env.FUEL_FINDER_BASE_URL || DEFAULT_BASE_URL,
  proxyUrl = process.env.FUEL_FINDER_PROXY_URL || null,
  proxySecret = process.env.FUEL_FINDER_PROXY_SECRET || null,
  httpClient = axios,
  requestDelayMs = Number(process.env.FUEL_FINDER_REQUEST_DELAY_MS) || DEFAULT_REQUEST_DELAY_MS,
  sleepFn = sleep,
} = {}) {
  if (!tokenManager) throw new Error('apiClient requires a tokenManager');
  let lastRequestAt = 0;

  async function throttle() {
    const delta = Date.now() - lastRequestAt;
    if (lastRequestAt && delta < requestDelayMs) {
      await sleepFn(requestDelayMs - delta);
    }
    lastRequestAt = Date.now();
  }

  function buildUrl(kind) {
    if (proxyUrl) {
      const path = kind === 'stations' ? PROXY_STATIONS_PATH : PROXY_PRICES_PATH;
      return `${proxyUrl}${path}`;
    }
    const path = kind === 'stations' ? STATIONS_PATH : PRICES_PATH;
    return `${baseUrl}${path}`;
  }

  function buildHeaders(token) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (proxyUrl && proxySecret) headers['x-proxy-secret'] = proxySecret;
    return headers;
  }

  async function request(kind, params, { attempt = 0 } = {}) {
    await throttle();
    const token = await tokenManager.getToken();
    try {
      const resp = await httpClient.get(buildUrl(kind), {
        params,
        headers: buildHeaders(token),
        timeout: 30000,
      });
      return resp.data;
    } catch (err) {
      // 401 -> token likely expired mid-flight; invalidate and retry once.
      if (err.response && err.response.status === 401 && attempt === 0) {
        tokenManager.invalidate();
        return request(kind, params, { attempt: attempt + 1 });
      }
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        const backoff = 1000 * Math.pow(2, attempt);
        await sleepFn(backoff);
        return request(kind, params, { attempt: attempt + 1 });
      }
      throw err;
    }
  }

  /**
   * Fetch a single batch of stations. Batches are 500 stations; callers
   * keep incrementing batch-number until the response length < 500.
   */
  async function getStationsBatch(batchNumber) {
    const body = await request('stations', { 'batch-number': batchNumber });
    return extractArray(body);
  }

  /**
   * Fetch a single batch of price updates since effectiveStartTimestamp.
   */
  async function getPricesBatch(batchNumber, effectiveStartTimestamp) {
    const params = { 'batch-number': batchNumber };
    if (effectiveStartTimestamp) {
      params['effective-start-timestamp'] = effectiveStartTimestamp;
    }
    const body = await request('prices', params);
    return extractArray(body);
  }

  return { getStationsBatch, getPricesBatch };
}

function extractArray(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && body.data && Array.isArray(body.data.stations)) return body.data.stations;
  if (body && Array.isArray(body.stations)) return body.stations;
  return [];
}

module.exports = { createApiClient, extractArray, isRetryable };

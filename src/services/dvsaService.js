'use strict';

/**
 * dvsaService.js
 * Wrapper around the DVSA MOT History API.
 *
 * GET https://history.mot.api.gov.uk/v1/trade/vehicles/registration/{reg}
 * x-api-key header with DVSA_MOT_API_KEY.
 *
 * Returns a `{ available, data, error }` envelope matching dvlaService so
 * the orchestrator can Promise.all them uniformly.
 */

const DVSA_BASE = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration';
const DEFAULT_TIMEOUT_MS = 8000;

function isConfigured() {
  return Boolean(process.env.DVSA_MOT_API_KEY);
}

async function fetchMotHistory(reg, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isConfigured()) {
    return { available: false, data: null, error: 'DVSA_MOT_API_KEY not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${DVSA_BASE}/${encodeURIComponent(reg)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': process.env.DVSA_MOT_API_KEY,
      },
      signal: controller.signal,
    });

    if (res.status === 404) {
      return { available: true, data: null, notFound: true, error: null };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: false,
        data: null,
        error: `DVSA API ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = await res.json();
    return { available: true, data, error: null };
  } catch (err) {
    return {
      available: false,
      data: null,
      error: err.name === 'AbortError' ? 'DVSA API timeout' : `DVSA API error: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchMotHistory, isConfigured, DVSA_BASE };

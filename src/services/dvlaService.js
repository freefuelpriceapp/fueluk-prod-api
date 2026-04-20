'use strict';

/**
 * dvlaService.js
 * Thin wrapper around the DVLA Vehicle Enquiry Service (VES) API.
 *
 * Returns a normalised `{ available, data, error }` envelope so the
 * orchestrator can merge DVLA with other sources without caring about
 * transport-level details.
 */

const DVLA_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
const DEFAULT_TIMEOUT_MS = 8000;

function isConfigured() {
  return Boolean(process.env.DVLA_API_KEY);
}

async function fetchDvla(reg, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isConfigured()) {
    return { available: false, data: null, error: 'DVLA_API_KEY not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(DVLA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': process.env.DVLA_API_KEY,
      },
      body: JSON.stringify({ registrationNumber: reg }),
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
        error: `DVLA API ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = await res.json();
    return { available: true, data, error: null };
  } catch (err) {
    return {
      available: false,
      data: null,
      error: err.name === 'AbortError' ? 'DVLA API timeout' : `DVLA API error: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchDvla, isConfigured, DVLA_URL };

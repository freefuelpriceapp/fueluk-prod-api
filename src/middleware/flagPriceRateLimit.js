'use strict';

/**
 * flagPriceRateLimit.js
 * Per-device daily cap on community price flags. The endpoint is already
 * device-id aware for dedup; this adds a ceiling so a single device can't
 * spam the queue. Request shape: body.device_id OR X-Device-ID header.
 */

const { createDeviceRateLimiter } = require('./rateLimiter');

const FLAG_DEVICE_MAX = 50;
const FLAG_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FLAG_IP_MAX = 60;
const FLAG_IP_WINDOW_MS = 60 * 60 * 1000;

const baseLimiter = createDeviceRateLimiter({
  deviceMax: FLAG_DEVICE_MAX,
  deviceWindowMs: FLAG_DEVICE_WINDOW_MS,
  ipMax: FLAG_IP_MAX,
  ipWindowMs: FLAG_IP_WINDOW_MS,
  label: 'flagPrice',
});

// The flag-price endpoint carries device_id in the request body, not a
// query param. Surface it via the X-Device-ID header so the shared
// device-rate-limiter picks it up without needing a second code path.
function flagPriceLimiter(req, res, next) {
  if (
    req && req.body && typeof req.body.device_id === 'string' && req.body.device_id.trim() &&
    !req.headers['x-device-id']
  ) {
    req.headers['x-device-id'] = req.body.device_id;
  }
  return baseLimiter(req, res, next);
}

module.exports = {
  flagPriceLimiter,
  FLAG_DEVICE_MAX,
  FLAG_DEVICE_WINDOW_MS,
  FLAG_IP_MAX,
  FLAG_IP_WINDOW_MS,
};

'use strict';

/**
 * vehicleRateLimit.js
 * Per-IP rate limiter for vehicle lookup endpoints.
 *
 * Vehicle lookups hit external government APIs with their own quotas, so
 * we cap clients at 10 requests/minute to stay well under DVLA's 5 req/sec
 * and avoid burning the DVSA budget on abusive callers.
 */

const { createRateLimiter } = require('./rateLimiter');

const VEHICLE_WINDOW_MS = 60 * 1000;
const VEHICLE_MAX = 10;

const vehicleLimiter = createRateLimiter(VEHICLE_MAX, VEHICLE_WINDOW_MS);

module.exports = { vehicleLimiter, VEHICLE_MAX, VEHICLE_WINDOW_MS };

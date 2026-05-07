'use strict';

/**
 * vehicleRateLimit.js
 * Rate limiter for vehicle lookup endpoints.
 *
 * Shifted from per-IP to per-device (SHA-256 of X-Device-ID / ?device_id)
 * so that shared networks (home, office, café WiFi) don't share a bucket.
 * Real app traffic always includes the header; scripts/curl without one
 * fall through to a generous per-IP ceiling so external quotas (DVLA,
 * DVSA) stay protected from runaway clients.
 *
 * MOT history lookups have a tighter cap (20/24h) than the combined
 * /lookup (30/24h) — pre-purchase MOT checks are higher-intent and the
 * DVSA MOT API quota is more sensitive.
 */

const { createDeviceRateLimiter } = require('./rateLimiter');

const VEHICLE_DEVICE_MAX = 30;
const VEHICLE_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling
const VEHICLE_IP_MAX = 60;
const VEHICLE_IP_WINDOW_MS = 60 * 60 * 1000; // 1h

const MOT_DEVICE_MAX = 20;
const MOT_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling
const MOT_IP_MAX = 40;
const MOT_IP_WINDOW_MS = 60 * 60 * 1000; // 1h

const vehicleLimiter = createDeviceRateLimiter({
  deviceMax: VEHICLE_DEVICE_MAX,
  deviceWindowMs: VEHICLE_DEVICE_WINDOW_MS,
  ipMax: VEHICLE_IP_MAX,
  ipWindowMs: VEHICLE_IP_WINDOW_MS,
  label: 'vehicleLookup',
});

const motLimiter = createDeviceRateLimiter({
  deviceMax: MOT_DEVICE_MAX,
  deviceWindowMs: MOT_DEVICE_WINDOW_MS,
  ipMax: MOT_IP_MAX,
  ipWindowMs: MOT_IP_WINDOW_MS,
  label: 'vehicleMot',
});

module.exports = {
  vehicleLimiter,
  motLimiter,
  VEHICLE_DEVICE_MAX,
  VEHICLE_DEVICE_WINDOW_MS,
  VEHICLE_IP_MAX,
  VEHICLE_IP_WINDOW_MS,
  MOT_DEVICE_MAX,
  MOT_DEVICE_WINDOW_MS,
  MOT_IP_MAX,
  MOT_IP_WINDOW_MS,
};

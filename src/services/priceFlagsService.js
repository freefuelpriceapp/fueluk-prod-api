'use strict';

/**
 * priceFlagsService.js — F6
 * Orchestrates a price flag: dedups by device+station+fuel in the last hour,
 * inserts the flag, counts distinct devices in the window, and auto-
 * quarantines the (station, fuel) price once 3+ distinct devices have
 * flagged within the hour.
 *
 * Pure, testable logic is split into `processFlag(deps, input)` so unit
 * tests can inject a fake repository.
 */

const crypto = require('crypto');
const defaultRepo = require('../repositories/priceFlagsRepository');

const ALLOWED_REASONS = new Set(['wrong', 'missing', 'closed']);
const ALLOWED_FUEL_TYPES = new Set([
  'E10',
  'E5',
  'B7',
  'petrol',
  'diesel',
  'super_unleaded',
  'premium_diesel',
]);
const QUARANTINE_THRESHOLD = 3;

function hashDeviceId(rawDeviceId) {
  if (typeof rawDeviceId !== 'string' || !rawDeviceId.trim()) return null;
  return crypto
    .createHash('sha256')
    .update(rawDeviceId.trim())
    .digest('hex');
}

function normaliseFuelType(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Accept both casings, canonicalise E10/E5/B7 to upper; others stay lower.
  if (/^(e10|e5|b7)$/i.test(trimmed)) return trimmed.toUpperCase();
  return trimmed.toLowerCase();
}

function normaliseReason(input) {
  if (!input) return 'wrong';
  const s = String(input).trim().toLowerCase();
  return ALLOWED_REASONS.has(s) ? s : 'wrong';
}

/**
 * processFlag — pure orchestration with injectable repo.
 * Returns one of:
 *   { status: 'received', flag_count_hour, quarantined, duplicate }
 *   { status: 'invalid',  message }
 */
async function processFlag({ repo = defaultRepo } = {}, input = {}) {
  const { stationId, fuelType: rawFuel, deviceId, reason: rawReason } = input;

  if (!stationId || typeof stationId !== 'string') {
    return { status: 'invalid', message: 'stationId is required' };
  }
  const fuelType = normaliseFuelType(rawFuel);
  if (!fuelType || !ALLOWED_FUEL_TYPES.has(fuelType)) {
    return { status: 'invalid', message: `fuel_type must be one of ${[...ALLOWED_FUEL_TYPES].join(', ')}` };
  }
  const deviceHash = hashDeviceId(deviceId);
  if (!deviceHash) {
    return { status: 'invalid', message: 'device_id is required' };
  }
  const reason = normaliseReason(rawReason);

  const duplicate = await repo.hasRecentFlagFromDevice({ stationId, fuelType, deviceHash });
  if (duplicate) {
    const count = await repo.countDistinctDevicesLastHour({ stationId, fuelType });
    return {
      status: 'received',
      flag_count_hour: count,
      quarantined: false,
      duplicate: true,
    };
  }

  await repo.insertFlag({ stationId, fuelType, deviceHash, reason });
  const count = await repo.countDistinctDevicesLastHour({ stationId, fuelType });

  let quarantined = false;
  if (count >= QUARANTINE_THRESHOLD) {
    try {
      await repo.upsertQuarantine({ stationId, fuelType, reason: 'community_flags' });
      quarantined = true;
    } catch (err) {
      console.warn('[priceFlags] upsertQuarantine failed:', err && err.message);
    }
  }

  return {
    status: 'received',
    flag_count_hour: count,
    quarantined,
    duplicate: false,
  };
}

module.exports = {
  processFlag,
  hashDeviceId,
  normaliseFuelType,
  normaliseReason,
  ALLOWED_REASONS,
  ALLOWED_FUEL_TYPES,
  QUARANTINE_THRESHOLD,
};

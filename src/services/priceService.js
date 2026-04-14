'use strict';

const priceRepository = require('../repositories/priceRepository');

/**
 * priceService.js
 * Business logic for price history, price alerts, and price comparison.
 * Sprint 8 — service layer separating controller from repository.
 */

/**
 * Get price history for a station and fuel type.
 * Returns hourly snapshots for the last N days.
 */
async function getPriceHistory({ stationId, fuelType = 'petrol', days = 7 }) {
  const history = await priceRepository.getPriceHistory({ stationId, fuelType, days });
  return history.map(row => ({
    station_id: row.station_id,
    fuel_type: row.fuel_type,
    price_pence: parseFloat(row.price_pence),
    recorded_at: row.recorded_at,
  }));
}

/**
 * Get all active price alerts for a device.
 */
async function getAlertsForDevice(deviceToken) {
  return priceRepository.getAlertsForDevice(deviceToken);
}

/**
 * Create a new price alert for a device/station/fuel combo.
 */
async function createAlert({ deviceToken, stationId, fuelType, thresholdPence, platform }) {
  return priceRepository.upsertAlert({ deviceToken, stationId, fuelType, thresholdPence, platform });
}

/**
 * Delete a price alert by ID, scoped to device token for safety.
 */
async function deleteAlert({ alertId, deviceToken }) {
  return priceRepository.deleteAlert({ alertId, deviceToken });
}

/**
 * Find all alerts that have been triggered by the latest price drop.
 * Used by the alertJob background worker.
 */
async function getTriggeredAlerts() {
  return priceRepository.getTriggeredAlerts();
}

module.exports = {
  getPriceHistory,
  getAlertsForDevice,
  createAlert,
  deleteAlert,
  getTriggeredAlerts,
};

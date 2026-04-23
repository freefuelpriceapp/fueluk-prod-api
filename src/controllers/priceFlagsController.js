'use strict';

const priceFlagsService = require('../services/priceFlagsService');

function envFlag(name, defaultOn = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultOn;
  return raw === 'true' || raw === '1';
}

/**
 * POST /api/v1/stations/:stationId/flag-price
 * Body: { fuel_type, device_id, reason? }
 */
async function flagPrice(req, res, next) {
  try {
    if (!envFlag('ENABLE_PRICE_FLAGS', true)) {
      return res.status(503).json({
        success: false,
        error: 'Service unavailable',
        message: 'Community price flagging is currently disabled',
      });
    }

    const { stationId } = req.params;
    const body = req.body || {};

    const result = await priceFlagsService.processFlag({}, {
      stationId,
      fuelType: body.fuel_type,
      deviceId: body.device_id,
      reason: body.reason,
    });

    if (result.status === 'invalid') {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: result.message,
      });
    }

    return res.json({
      status: 'received',
      flag_count_hour: result.flag_count_hour,
      quarantined: result.quarantined,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { flagPrice };

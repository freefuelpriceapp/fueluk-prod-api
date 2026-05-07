'use strict';

const premiumRepository = require('../repositories/premiumRepository');

/**
 * requirePremium middleware - Sprint 7
 * Blocks access to premium-gated routes if the requesting device
 * does not have an active premium subscription.
 *
 * Reads device token from header: X-Device-Token
 * Returns 403 if the device is on the free tier.
 */
async function requirePremium(req, res, next) {
  try {
    const deviceToken = req.headers['x-device-token'];

    if (!deviceToken) {
      return res.status(403).json({
        success: false,
        error: 'Premium subscription required',
        message: 'Provide X-Device-Token header to access this feature',
      });
    }

    const record = await premiumRepository.getPremiumByDevice(deviceToken);

    // Check if record exists, is premium tier, and not expired
    const isActive =
      record &&
      record.tier === 'premium' &&
      (!record.expires_at || new Date(record.expires_at) > new Date());

    if (!isActive) {
      return res.status(403).json({
        success: false,
        error: 'Premium subscription required',
        message: 'Upgrade to FuelUK Premium to access this feature',
        upgrade_url: '/api/v1/premium/register',
      });
    }

    // Attach premium record to request for downstream use
    req.premiumUser = record;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requirePremium;

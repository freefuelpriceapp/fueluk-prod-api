'use strict';

/**
 * premiumController.js - Sprint 7
 * Handles premium tier entitlements and pro features.
 */

async function getPremiumStatus(req, res, next) {
  try {
    // Initial implementation: returns default free status
    return res.json({
      success: true,
      is_premium: false,
      tier: 'free',
      features: ['basic_search', 'nearby_map'],
      expires_at: null
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPremiumStatus
};

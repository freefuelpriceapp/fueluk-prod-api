'use strict';

const premiumRepository = require('../repositories/premiumRepository');

/**
 * premiumController.js - Sprint 7
 * Handles premium tier entitlements: status check, device registration, upgrade.
 */

const FREE_FEATURES = ['basic_search', 'nearby_map', 'station_detail', 'fuel_freshness', 'favourites_local'];
const PREMIUM_FEATURES = [...FREE_FEATURES, 'price_alerts', 'price_history_charts', 'route_intelligence', 'ad_free'];

/**
 * GET /api/v1/premium/status
 * Returns the current premium tier for a device.
 * Reads device_token from header X-Device-Token.
 */
async function getPremiumStatus(req, res, next) {
  try {
    const deviceToken = req.headers['x-device-token'];
    if (!deviceToken) {
      return res.json({
        success: true,
        is_premium: false,
        tier: 'free',
        features: FREE_FEATURES,
        expires_at: null,
      });
    }

    const record = await premiumRepository.getPremiumByDevice(deviceToken);

    // Auto-expire if past expiry
    if (record && record.tier !== 'free' && record.expires_at && new Date(record.expires_at) < new Date()) {
      await premiumRepository.upsertPremiumUser({
        deviceToken,
        tier: 'free',
        subscribedAt: record.subscribed_at,
        expiresAt: null,
        receiptToken: record.receipt_token,
        platform: record.platform,
      });
      return res.json({
        success: true,
        is_premium: false,
        tier: 'free',
        features: FREE_FEATURES,
        expires_at: null,
      });
    }

    const isPremium = record && record.tier === 'premium';
    return res.json({
      success: true,
      is_premium: isPremium,
      tier: record ? record.tier : 'free',
      features: isPremium ? PREMIUM_FEATURES : FREE_FEATURES,
      expires_at: record ? record.expires_at : null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/premium/register
 * Register a device as a premium subscriber.
 * Body: { device_token, receipt_token, platform, expires_at }
 */
async function registerPremium(req, res, next) {
  try {
    const { device_token, receipt_token, platform, expires_at } = req.body;

    if (!device_token) {
      return res.status(400).json({ success: false, error: 'device_token is required' });
    }
    if (!receipt_token) {
      return res.status(400).json({ success: false, error: 'receipt_token is required' });
    }

    const record = await premiumRepository.upsertPremiumUser({
      deviceToken: device_token,
      tier: 'premium',
      subscribedAt: new Date(),
      expiresAt: expires_at ? new Date(expires_at) : null,
      receiptToken: receipt_token,
      platform: platform || 'unknown',
    });

    return res.status(201).json({
      success: true,
      message: 'Premium subscription activated',
      tier: record.tier,
      expires_at: record.expires_at,
      features: PREMIUM_FEATURES,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/premium/cancel
 * Downgrade a device back to free tier.
 * Body: { device_token }
 */
async function cancelPremium(req, res, next) {
  try {
    const { device_token } = req.body;
    if (!device_token) {
      return res.status(400).json({ success: false, error: 'device_token is required' });
    }

    const existing = await premiumRepository.getPremiumByDevice(device_token);
    if (!existing) {
      return res.json({ success: true, message: 'No premium record found; already free tier' });
    }

    await premiumRepository.upsertPremiumUser({
      deviceToken: device_token,
      tier: 'free',
      subscribedAt: existing.subscribed_at,
      expiresAt: null,
      receiptToken: existing.receipt_token,
      platform: existing.platform,
    });

    return res.json({
      success: true,
      message: 'Premium subscription cancelled. Downgraded to free tier.',
      tier: 'free',
      features: FREE_FEATURES,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPremiumStatus,
  registerPremium,
  cancelPremium,
};

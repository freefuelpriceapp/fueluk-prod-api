'use strict';

const { getPool } = require('../config/db');

/**
 * premiumRepository.js - Sprint 7
 * DB-backed queries for the premium_users table.
 */

/**
 * Get premium record by device token.
 * Returns null if not found.
 */
async function getPremiumByDevice(deviceToken) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM premium_users WHERE device_token = $1 LIMIT 1`,
    [deviceToken]
  );
  return result.rows[0] || null;
}

/**
 * Upsert a premium record for a device.
 * Called on registration or upgrade.
 */
async function upsertPremiumUser({
  deviceToken,
  tier,
  subscribedAt,
  expiresAt,
  receiptToken,
  platform,
}) {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO premium_users
       (device_token, tier, subscribed_at, expires_at, receipt_token, platform, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (device_token) DO UPDATE SET
       tier          = EXCLUDED.tier,
       subscribed_at = EXCLUDED.subscribed_at,
       expires_at    = EXCLUDED.expires_at,
       receipt_token = EXCLUDED.receipt_token,
       platform      = EXCLUDED.platform,
       updated_at    = NOW()
     RETURNING *`,
    [deviceToken, tier, subscribedAt || null, expiresAt || null, receiptToken || null, platform || 'unknown']
  );
  return result.rows[0];
}

/**
 * Downgrade expired premium users back to free tier.
 * Called by a background job or on-demand check.
 */
async function expireOverduePremiumUsers() {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE premium_users
     SET tier = 'free', updated_at = NOW()
     WHERE tier <> 'free'
       AND expires_at IS NOT NULL
       AND expires_at < NOW()
     RETURNING device_token`
  );
  return result.rows;
}

module.exports = {
  getPremiumByDevice,
  upsertPremiumUser,
  expireOverduePremiumUsers,
};

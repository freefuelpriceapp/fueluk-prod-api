'use strict';
const cron = require('node-cron');
const { getPool } = require('../config/db');
const { isEnabled } = require('../utils/featureFlags');

/**
 * alertJob.js — Sprint 4
 * Checks active price alerts against current station prices every 15 minutes.
 * When a station's current price for a fuel type drops AT or BELOW a user's
 * threshold_pence, fires a push notification via Expo Push API and updates
 * last_notified_at to prevent repeat notifications within 24 hours.
 *
 * Push notifications use Expo's push service (no APNs/FCM creds required
 * server-side when using Expo managed workflow).
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const NOTIFY_COOLDOWN_HOURS = 24;

/**
 * sendExpoPushNotification
 * Fires a batch of Expo push messages.
 * @param {Array<{to, title, body, data}>} messages
 */
async function sendExpoPushNotifications(messages) {
  if (!messages || messages.length === 0) return;
  try {
    // Use dynamic import-compatible fetch (Node 18+ has global fetch)
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    const json = await res.json();
    console.log(`[AlertJob] Push batch sent: ${messages.length} notifications`, JSON.stringify(json?.data?.slice(0, 3)));
  } catch (err) {
    console.error('[AlertJob] Push send error:', err.message);
  }
}

/**
 * runAlertCheck
 * Main job function. Queries all active alerts where:
 *   1. The station currently has a price for the alert's fuel_type
 *   2. That price is <= threshold_pence
 *   3. We haven't already notified within the last NOTIFY_COOLDOWN_HOURS hours
 * Sends push notifications and updates last_notified_at.
 */
async function runAlertCheck() {
  if (!isEnabled('price_alerts')) {
    return { skipped: true, reason: 'price_alerts feature flag disabled' };
  }

  const pool = getPool();
  const startedAt = new Date();
  console.log(`[AlertJob] Running alert check at ${startedAt.toISOString()}`);

  try {
    // Find all alerts that should fire
    const { rows: triggeredAlerts } = await pool.query(`
      SELECT
        pa.id,
        pa.device_token,
        pa.platform,
        pa.fuel_type,
        pa.threshold_pence,
        s.name   AS station_name,
        s.brand  AS station_brand,
        s.address AS station_address,
        CASE pa.fuel_type
          WHEN 'petrol' THEN s.petrol_price
          WHEN 'diesel' THEN s.diesel_price
          WHEN 'e10'    THEN s.e10_price
        END AS current_price
      FROM price_alerts pa
      JOIN stations s ON s.id = pa.station_id
      WHERE pa.active = true
        AND (
          pa.last_notified_at IS NULL
          OR pa.last_notified_at < NOW() - INTERVAL '${NOTIFY_COOLDOWN_HOURS} hours'
        )
        AND (
          (pa.fuel_type = 'petrol' AND s.petrol_price IS NOT NULL AND s.petrol_price <= pa.threshold_pence)
          OR (pa.fuel_type = 'diesel' AND s.diesel_price IS NOT NULL AND s.diesel_price <= pa.threshold_pence)
          OR (pa.fuel_type = 'e10'    AND s.e10_price    IS NOT NULL AND s.e10_price    <= pa.threshold_pence)
        )
    `);

    if (triggeredAlerts.length === 0) {
      console.log('[AlertJob] No alerts to fire.');
      return { checked: 0, fired: 0, durationMs: Date.now() - startedAt };
    }

    console.log(`[AlertJob] ${triggeredAlerts.length} alert(s) to fire.`);

    // Build Expo push messages
    const messages = triggeredAlerts
      .filter(a => a.device_token && a.device_token.startsWith('ExponentPushToken'))
      .map(a => ({
        to: a.device_token,
        sound: 'default',
        title: `⛽ ${a.fuel_type.charAt(0).toUpperCase() + a.fuel_type.slice(1)} price alert!`,
        body: `${a.station_brand || a.station_name} is now ${(a.current_price / 100).toFixed(1)}p/L — below your ${(a.threshold_pence / 100).toFixed(1)}p target.`,
        data: {
          alertId: a.id,
          fuelType: a.fuel_type,
          currentPrice: a.current_price,
          stationName: a.station_name || a.station_brand,
        },
      }));

    // Send push notifications
    if (messages.length > 0) {
      await sendExpoPushNotifications(messages);
    }

    // Update last_notified_at for all fired alerts
    const firedIds = triggeredAlerts.map(a => a.id);
    await pool.query(
      `UPDATE price_alerts
       SET last_notified_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1::bigint[])`,
      [firedIds]
    );

    const durationMs = Date.now() - startedAt;
    console.log(`[AlertJob] Done. Fired ${firedIds.length} alerts in ${durationMs}ms.`);
    return { checked: triggeredAlerts.length, fired: firedIds.length, durationMs };
  } catch (err) {
    console.error('[AlertJob] Error during alert check:', err.message);
    throw err;
  }
}

/**
 * startAlertJob
 * Schedules the alert checker to run every 15 minutes.
 * Configurable via ALERT_CRON env var.
 */
function startAlertJob() {
  const schedule = process.env.ALERT_CRON || '*/15 * * * *'; // every 15 min
  console.log(`[AlertJob] Starting alert checker with schedule: "${schedule}"`);

  cron.schedule(schedule, async () => {
    console.log('[AlertJob] Cron trigger fired');
    try {
      await runAlertCheck();
    } catch (err) {
      console.error('[AlertJob] Uncaught error in scheduled run:', err.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/London',
  });
}

module.exports = { startAlertJob, runAlertCheck };

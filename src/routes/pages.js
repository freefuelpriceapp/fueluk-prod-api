'use strict';
const express = require('express');
const router = express.Router();

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - FreeFuelPrice UK</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6; }
    h1 { color: #1a73e8; }
    h2 { color: #555; margin-top: 24px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f5f5f5; }
    a { color: #1a73e8; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>Effective date:</strong> 17 April 2026<br><strong>Last updated:</strong> 17 April 2026<br><strong>App:</strong> FreeFuelPrice UK v9.0.0 (iOS &amp; Android)<br><strong>Contact:</strong> <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a></p>

  <h2>1. Summary</h2>
  <p>FreeFuelPrice UK is a fuel price comparison app for UK drivers. It is privacy-first:</p>
  <ul>
    <li><strong>No account required.</strong> You do not sign up or give us your name, email, or phone number.</li>
    <li><strong>We do not sell, rent, or share your personal data</strong> with advertisers, data brokers, or trackers.</li>
    <li><strong>We do not track you</strong> across apps or websites.</li>
    <li><strong>Your location is used only in the moment</strong> to show fuel stations near you. It is not stored on our servers.</li>
    <li><strong>Favourites stay on your device.</strong> We do not see them.</li>
    <li><strong>Data in transit is encrypted</strong> (HTTPS/TLS).</li>
  </ul>

  <h2>2. Data We Collect and Why</h2>
  <table>
    <tr><th>Data</th><th>Purpose</th><th>Stored on servers?</th><th>Linked to you?</th><th>Shared?</th></tr>
    <tr><td>Precise location</td><td>Find nearby fuel stations</td><td>No &mdash; transient</td><td>No</td><td>No</td></tr>
    <tr><td>Approximate location</td><td>Fallback for nearby</td><td>No</td><td>No</td><td>No</td></tr>
    <tr><td>Device ID / push token</td><td>Price alerts (optional)</td><td>Yes, alert record only</td><td>No</td><td>No</td></tr>
    <tr><td>Favourites</td><td>Quick access to stations</td><td>No &mdash; local only</td><td>N/A</td><td>No</td></tr>
    <tr><td>Crash/diagnostic data</td><td>App stability</td><td>Aggregated only</td><td>No</td><td>No</td></tr>
  </table>
  <p>We do <strong>not</strong> collect: name, email, phone, address, contacts, messages, browsing history, health, financial, photo, or biometric data.</p>

  <h2>3. Legal Basis (UK GDPR)</h2>
  <ul>
    <li><strong>Legitimate interests</strong> (Art 6(1)(f)) &mdash; delivering the nearby-fuel feature.</li>
    <li><strong>Consent</strong> (Art 6(1)(a)) &mdash; optional location access and push notifications. Withdraw any time in device settings.</li>
  </ul>

  <h2>4. How Location Works</h2>
  <p>When you grant permission, your device sends coordinates to our API over HTTPS. We compute nearby stations and return results. Coordinates are not written to any database, log, or analytics system that identifies you, and are not shared with third parties.</p>
  <p>If you deny location, the app still works &mdash; search by postcode or town.</p>

  <h2>5. Price Alerts (Optional)</h2>
  <p>If you create a price alert, we store: station ID, fuel type, threshold, and a push token. These are not linked to a name, email, or account. Delete any alert from the Alerts screen to remove it from our backend.</p>

  <h2>6. Data Sources</h2>
  <p>Fuel prices come from public UK datasets (UKPIA, CMA, Gov.UK). These describe retailers, not you.</p>

  <h2>7. Data Sharing</h2>
  <p>We do <strong>not</strong> share personal data with third parties. No advertising SDKs, no marketing attribution, no cross-app trackers. No ads at launch.</p>
  <p>Infrastructure providers (AWS, Expo push) act as data processors to host and deliver the service only.</p>

  <h2>8. International Transfers</h2>
  <p>Some infrastructure is outside the UK. Transfers are protected by standard contractual clauses and providers' adequacy frameworks.</p>

  <h2>9. Data Retention</h2>
  <ul>
    <li>Location: not retained &mdash; discarded after query.</li>
    <li>Alert records: retained until you delete or uninstall.</li>
    <li>Favourites: on-device until you remove or uninstall.</li>
    <li>Diagnostic data: up to 90 days, aggregated.</li>
  </ul>

  <h2>10. Your Rights</h2>
  <p>We hold no data identifying you (no name/email/account), so most access requests do not apply. You can:</p>
  <ul>
    <li>Revoke location permission in device settings.</li>
    <li>Disable push notifications in device settings.</li>
    <li>Delete alerts inside the app.</li>
    <li>Uninstall the app to remove all local data.</li>
    <li>Contact us at <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a>.</li>
  </ul>
  <p>You may lodge a complaint with the <a href="https://ico.org.uk">UK ICO</a>.</p>

  <h2>11. Children</h2>
  <p>Rated 4+ (iOS) / Everyone (Android). We do not knowingly collect personal data from children. No account system exists.</p>

  <h2>12. Security</h2>
  <ul>
    <li>HTTPS/TLS encryption in transit.</li>
    <li>Secrets in AWS Secrets Manager, not in the app.</li>
    <li>Favourites stored locally on device only.</li>
  </ul>

  <h2>13. Store Privacy Declarations</h2>
  <p><strong>iOS App Privacy:</strong> Precise Location and Device ID collected, neither linked to you, no tracking.<br>
  <strong>Google Play Data Safety:</strong> Approximate location, precise location, device ID collected; none shared; precise location required for nearby; all else optional.</p>

  <h2>14. Changes</h2>
  <p>Material changes will update this date and, where required, notify users in-app.</p>

  <h2>15. Contact</h2>
  <p>FreeFuelPrice UK<br>Email: <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a><br>Support: <a href="https://api.freefuelpriceapp.com/support">https://api.freefuelpriceapp.com/support</a></p>
</body>
</html>`;

const SUPPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Support - FreeFuelPrice UK</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6; }
    h1 { color: #1a73e8; }
    h2 { color: #555; margin-top: 24px; }
    a { color: #1a73e8; }
  </style>
</head>
<body>
  <h1>Support</h1>
  <p>Need help with FreeFuelPrice UK? We are here to assist.</p>
  <h2>Contact Us</h2>
  <p>Email: <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a></p>
  <h2>FAQs</h2>
  <p><strong>How are fuel prices sourced?</strong><br>Prices come from official UK government open data, updated regularly.</p>
  <p><strong>Why does the app need my location?</strong><br>Location is used to show fuel stations near you. You can deny access and search manually.</p>
  <p><strong>Is the app free?</strong><br>Yes. Core features are free with no ads.</p>
  <h2>App Version</h2>
  <p>Current version: 9.0.0</p>
</body>
</html>`;

router.get('/privacy', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(PRIVACY_HTML);
});

router.get('/support', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(SUPPORT_HTML);
});

module.exports = router;

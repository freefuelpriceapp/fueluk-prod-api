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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 760px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6; }
    h1 { color: #1a73e8; }
    h2 { color: #555; margin-top: 24px; }
    h3 { color: #666; margin-top: 18px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    a { color: #1a73e8; }
    address { font-style: normal; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>Effective date:</strong> 20 April 2026<br>
  <strong>Last updated:</strong> 20 April 2026<br>
  <strong>App:</strong> FreeFuelPrice UK v9.1.0 (iOS &amp; Android)</p>

  <h2>1. Summary</h2>
  <p>FreeFuelPrice UK is a fuel price comparison app for UK drivers. It is privacy-first:</p>
  <ul>
    <li><strong>No user accounts.</strong> We do not collect your name, email address, phone number, or password. There is no sign-up or login.</li>
    <li><strong>No advertising.</strong> No ads, no ad SDKs, no marketing attribution.</li>
    <li><strong>No cross-app or cross-site tracking.</strong> We do not profile you.</li>
    <li><strong>No sale or rental of personal data</strong> to third parties, data brokers, or analytics vendors.</li>
    <li><strong>Location is used in the moment</strong> to find stations near you and is not stored on our servers.</li>
    <li><strong>Favourites stay on your device.</strong> We never see them.</li>
    <li><strong>All data in transit is encrypted</strong> (HTTPS/TLS).</li>
  </ul>

  <h2>2. Data Controller</h2>
  <address>
  <strong>Free Fuel Price App Ltd</strong><br>
  38 Shawbury Grove<br>
  Birmingham, B12 0TT<br>
  United Kingdom<br>
  Email: <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a>
  </address>

  <h2>3. Data We Collect</h2>
  <table>
    <tr>
      <th>Data</th>
      <th>Purpose</th>
      <th>Lawful basis (UK GDPR Art 6)</th>
      <th>Retention</th>
      <th>Shared with</th>
    </tr>
    <tr>
      <td>Expo push token</td>
      <td>Deliver push notifications when a price alert fires</td>
      <td>Consent (Art 6(1)(a)) &mdash; granted by creating an alert and by OS notification permission</td>
      <td>Held only while the alert is active; deleted when the alert is deleted or the app is uninstalled</td>
      <td>Expo push service (processor) for delivery only</td>
    </tr>
    <tr>
      <td>Device platform (iOS / Android)</td>
      <td>Route push notifications via the correct delivery channel</td>
      <td>Consent (Art 6(1)(a))</td>
      <td>Same as push token &mdash; tied to the alert record</td>
      <td>Expo push service (processor)</td>
    </tr>
    <tr>
      <td>Trip origin and destination coordinates</td>
      <td>Calculate a route and find stations along the journey when you use the Trip Planner</td>
      <td>Legitimate interests (Art 6(1)(f)) &mdash; providing the route calculation you requested</td>
      <td>Not stored. Used in the request and discarded when the response is returned</td>
      <td>Not shared</td>
    </tr>
    <tr>
      <td>Vehicle Registration Number (VRM)</td>
      <td>Look up vehicle details (make, model, tax and MOT status, MOT history) at your explicit request</td>
      <td>Legitimate interests (Art 6(1)(f)) &mdash; providing the vehicle status check you requested. VRMs are personal data under UK GDPR because they can be linked to a named keeper via DVLA records.</td>
      <td>Not stored beyond the request lifecycle. A short-lived cache (up to 24 hours) holds the response to reduce duplicate upstream calls; no user identifier is stored with it.</td>
      <td>Forwarded to the <strong>DVLA Vehicle Enquiry Service (VES) API</strong> and the <strong>DVSA MOT History API</strong>, both operated by UK government agencies</td>
    </tr>
    <tr>
      <td>Approximate / precise location (lat, lon)</td>
      <td>Find fuel stations near you</td>
      <td>Consent (Art 6(1)(a)) &mdash; granted via OS location permission</td>
      <td>Not retained. Passed as query parameters, used to compute nearby stations, and discarded. Not written to logs or analytics with any identifier.</td>
      <td>Not shared</td>
    </tr>
    <tr>
      <td>Favourites</td>
      <td>Quick access to saved stations</td>
      <td>Not personal data &mdash; stored on your device only</td>
      <td>Held on device until you remove them or uninstall the app</td>
      <td>Not shared</td>
    </tr>
    <tr>
      <td>Aggregated diagnostic / crash data</td>
      <td>App stability and error tracking</td>
      <td>Legitimate interests (Art 6(1)(f))</td>
      <td>Up to 90 days, aggregated</td>
      <td>Infrastructure provider (AWS) as processor</td>
    </tr>
  </table>

  <h2>4. What We Do NOT Collect</h2>
  <p>FreeFuelPrice UK does <strong>not</strong> collect any of the following:</p>
  <ul>
    <li>Name, email address, phone number, postal address, or date of birth</li>
    <li>Passwords or authentication credentials (there are no user accounts)</li>
    <li>Contacts, calendars, photos, or files from your device</li>
    <li>Browsing history, search history outside the app, or clipboard data</li>
    <li>Health, financial, biometric, or payment information</li>
    <li>Advertising identifiers (IDFA, GAID)</li>
    <li>Any data used for targeted advertising, marketing attribution, or cross-app tracking</li>
  </ul>

  <h2>5. How Specific Features Handle Your Data</h2>

  <h3>5.1 Price Alerts</h3>
  <p>When you create a price alert (<code>POST /api/v1/alerts</code>) the app sends us:</p>
  <ul>
    <li>The station ID and fuel type you want to watch</li>
    <li>Your price threshold</li>
    <li>Your <strong>Expo push token</strong> &mdash; an opaque device identifier issued by Expo for delivering push notifications</li>
    <li>Your <strong>device platform</strong> (<code>ios</code> or <code>android</code>)</li>
  </ul>
  <p>The push token and platform are stored only so the alert job can send you a notification when the price hits your threshold. They are not linked to a name, email, or account. You can delete a single alert from the Alerts screen. To remove <strong>every alert tied to your device</strong> (for example when uninstalling or switching phones), the app can call <code>DELETE /api/v1/alerts/token/&lt;your-push-token&gt;</code>, which wipes all active alerts for that token.</p>

  <h3>5.2 Trip Planner</h3>
  <p>When you plan a trip the app sends origin and destination coordinates to <code>POST /api/v1/trip/calculate</code>. These coordinates are used to compute the route and nearby stations, then discarded. They are not written to any database or log that identifies you.</p>

  <h3>5.3 Vehicle Check</h3>
  <p>When you check a vehicle the app sends the vehicle registration number (VRM) to <code>POST /api/v1/vehicles/lookup</code>. We forward the VRM to the <strong>DVLA VES API</strong> (for tax, MOT-due, make, model, CO<sub>2</sub>) and to the <strong>DVSA MOT History API</strong> (for historical MOT results). The response is returned to you and cached on our backend for up to 24 hours, keyed only by the normalised plate, to prevent duplicate upstream calls. No user identifier is stored with the cache entry. We do not retain a log of which device looked up which plate.</p>
  <p>VRMs are treated as personal data under UK GDPR because DVLA records link a plate to a named keeper, even though the app does not know the keeper. Our lawful basis is legitimate interests: you explicitly asked us to look up the vehicle status.</p>

  <h3>5.4 Nearby Stations</h3>
  <p>Station search accepts <code>lat</code> and <code>lon</code> query parameters. They are used in the request to filter stations by distance and are not written to logs alongside any device identifier.</p>

  <h2>6. Third-Party Sub-Processors</h2>
  <table>
    <tr><th>Provider</th><th>Role</th><th>Data processed</th></tr>
    <tr><td>Amazon Web Services (AWS)</td><td>Hosting, database, secrets management</td><td>All backend data listed above</td></tr>
    <tr><td>Expo push service (expo.dev)</td><td>Push notification delivery</td><td>Push token, platform, notification body</td></tr>
    <tr><td>DVLA &mdash; Vehicle Enquiry Service API</td><td>Source for vehicle tax / MOT / make / model</td><td>Vehicle registration number (when you use Vehicle Check)</td></tr>
    <tr><td>DVSA &mdash; MOT History API</td><td>Source for MOT test history</td><td>Vehicle registration number (when you use Vehicle Check)</td></tr>
  </table>
  <p>These providers act as processors (or independent controllers in the case of DVLA and DVSA) and handle data only for the purposes described. No advertising, analytics, or marketing vendors are used.</p>

  <h2>7. International Transfers</h2>
  <p>Some infrastructure providers operate outside the UK. Transfers are protected by standard contractual clauses and the providers' adequacy frameworks. DVLA and DVSA process data within the UK.</p>

  <h2>8. Data Retention Summary</h2>
  <ul>
    <li><strong>Location coordinates (nearby search):</strong> not retained &mdash; discarded after the request.</li>
    <li><strong>Trip origin / destination coordinates:</strong> not retained &mdash; discarded after the request.</li>
    <li><strong>Vehicle registration:</strong> not retained beyond the request; cached response held up to 24 hours with no user identifier.</li>
    <li><strong>Price alert records (incl. push token &amp; platform):</strong> held while the alert is active; removed when you delete the alert or call the bulk-delete endpoint; auto-expired when the app detects the push token is invalid.</li>
    <li><strong>Favourites:</strong> on-device only, until you remove them or uninstall the app.</li>
    <li><strong>Aggregated diagnostic data:</strong> up to 90 days.</li>
  </ul>

  <h2>9. Your Rights Under UK GDPR</h2>
  <p>Because we hold no data that identifies you by name, email, or account, most subject requests have a narrow scope &mdash; but your rights still apply:</p>
  <ul>
    <li><strong>Right of access (Art 15):</strong> email us your Expo push token and we will tell you which alerts (if any) we hold for it.</li>
    <li><strong>Right to erasure / "right to be forgotten" (Art 17):</strong> delete alerts individually in the app, or use the in-app "Delete all my alerts" option which calls <code>DELETE /api/v1/alerts/token/&lt;push-token&gt;</code>. You can also email <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a> with your push token and we will delete all associated alerts within 30 days.</li>
    <li><strong>Right to data portability (Art 20):</strong> on request we will export the alert records held for your push token as JSON.</li>
    <li><strong>Right to rectification (Art 16):</strong> alerts can be recreated at any time via the app.</li>
    <li><strong>Right to object / withdraw consent (Art 21 / Art 7(3)):</strong> revoke location or notification permissions in your device settings at any time; this does not require contacting us.</li>
    <li><strong>Right to lodge a complaint:</strong> with the <a href="https://ico.org.uk">UK Information Commissioner's Office (ICO)</a>.</li>
  </ul>

  <h3>How to Request Data Deletion</h3>
  <p>Three options:</p>
  <ol>
    <li>Open the app and delete each alert individually, or use "Delete all my alerts" to call the bulk-delete endpoint.</li>
    <li>Uninstall the app &mdash; this removes all on-device data (favourites, cached responses).</li>
    <li>Email <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a> with your Expo push token (shown in the app's About screen). We will confirm deletion within 30 days.</li>
  </ol>

  <h2>10. Children</h2>
  <p>Rated 4+ (iOS) / Everyone (Android). We do not knowingly collect personal data from children. There is no account system.</p>

  <h2>11. Security</h2>
  <ul>
    <li>HTTPS/TLS encryption for all traffic in transit.</li>
    <li>Secrets held in AWS Secrets Manager, not embedded in the app binary.</li>
    <li>Database access restricted to the backend service.</li>
    <li>No user credentials stored &mdash; there are none to leak.</li>
  </ul>

  <h2>12. Store Privacy Declarations</h2>
  <p><strong>iOS App Privacy:</strong> Precise Location and Device ID (push token) collected; neither linked to your identity; no tracking.<br>
  <strong>Google Play Data Safety:</strong> Approximate location, precise location, and device ID (push token) collected; none shared for advertising; precise location required for nearby search; all other collection optional.</p>

  <h2>13. Changes to This Policy</h2>
  <p>Material changes will update the "Last updated" date above. Significant changes that affect your rights will also be surfaced in-app before they take effect.</p>

  <h2>14. Contact</h2>
  <address>
  Free Fuel Price App Ltd<br>
  38 Shawbury Grove, Birmingham, B12 0TT, United Kingdom<br>
  Email: <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a><br>
  Support page: <a href="https://api.freefuelpriceapp.com/support">https://api.freefuelpriceapp.com/support</a>
  </address>
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
  <p>Current version: 9.1.0</p>
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

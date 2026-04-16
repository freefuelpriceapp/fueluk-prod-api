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
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>Last updated:</strong> April 2026</p>
  <h2>What We Collect</h2>
  <p>FreeFuelPrice UK collects your approximate location (when permitted) to show nearby fuel stations. We do not collect or store personal information beyond what is needed to operate the app.</p>
  <h2>How We Use Data</h2>
  <p>Location data is used solely to find fuel stations near you. Search queries are processed in real time and not stored. We use anonymous analytics to improve the app experience.</p>
  <h2>Third-Party Services</h2>
  <p>We use government open data for fuel prices. We do not sell or share your personal data with third parties.</p>
  <h2>Data Storage</h2>
  <p>Favourites and preferences are stored locally on your device. No account creation is required.</p>
  <h2>Contact</h2>
  <p>For privacy questions, email <a href="mailto:support@freefuelpriceapp.com">support@freefuelpriceapp.com</a>.</p>
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
  <p>Current version: 1.0.0</p>
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

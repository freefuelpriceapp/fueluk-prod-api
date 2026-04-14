'use strict'; const { version } = require('../../package.json');
const router = require('express').Router();
const { getPool } = require('../config/db');

router.get('/', async (req, res) => {
  let dbStatus = 'unknown';
  try {
    await getPool().query('SELECT 1');
    dbStatus = 'connected';
  } catch (e) {
    dbStatus = 'error: ' + e.message;
  }
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version,
        uptime_seconds: Math.floor(process.uptime()),
    db: dbStatus
  });
});

module.exports = router;

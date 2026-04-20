'use strict';
const router = require('express').Router();
const { getPool } = require('../config/db');
const { cacheFor } = require('../middleware/responseCache');

// GET /api/v1/meta/last-updated
router.get('/last-updated', cacheFor(60), async (req, res, next) => {
  try {
    const result = await getPool().query(
      'SELECT MAX(last_updated) AS last_updated FROM stations'
    );
    const lastUpdated = result.rows[0].last_updated;
    res.json({
      last_updated: lastUpdated ? lastUpdated.toISOString() : null,
      status: lastUpdated ? 'ok' : 'no_data'
    });
  } catch (err) { next(err); }
});

module.exports = router;

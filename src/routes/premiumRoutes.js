'use strict';

const express = require('express');
const router = express.Router();
const premiumController = require('../controllers/premiumController');

/**
 * @route   GET /api/v1/premium/status
 * @desc    Get current user's premium tier and features
 * @access  Private (Internal/Initial)
 */
router.get('/status', premiumController.getPremiumStatus);

module.exports = router;

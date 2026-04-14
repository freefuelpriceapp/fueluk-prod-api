'use strict';

const express = require('express');
const router = express.Router();
const premiumController = require('../controllers/premiumController');

/**
 * @route   GET /api/v1/premium/status
 * @desc    Get current user's premium tier and features
 * @access  Private (X-Device-Token)
 */
router.get('/status', premiumController.getPremiumStatus);

/**
 * @route   POST /api/v1/premium/register
 * @desc    Register or activate premium subscription for a device
 * @access  Private (X-Device-Token)
 */
router.post('/register', premiumController.registerPremium);

/**
 * @route   DELETE /api/v1/premium/cancel
 * @desc    Cancel premium and downgrade device to free tier
 * @access  Private (X-Device-Token)
 */
router.delete('/cancel', premiumController.cancelPremium);

module.exports = router;

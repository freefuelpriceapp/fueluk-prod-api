'use strict';
const router = require('express').Router();
const stationController = require('../controllers/stationController');
const priceFlagsController = require('../controllers/priceFlagsController');
const { cacheFor } = require('../middleware/responseCache');

/**
 * GET /api/v1/stations/nearby
 * Query params: lat, lon, radius (km), fuel_type, brand
 */
router.get('/nearby', cacheFor(30), stationController.getNearby);

/**
 * GET /api/v1/stations/cheapest
 * Query params: lat, lon, radius (km), fuel_type
 */
router.get('/cheapest', cacheFor(30), stationController.getCheapest);

/**
 * GET /api/v1/stations/brands
 * Returns distinct brand list for filter UI
 */
router.get('/brands', cacheFor(300), stationController.getBrands);

/**
 * GET /api/v1/stations/search
 * Query params: q (search term)
 */
router.get('/search', cacheFor(60), stationController.search);

/**
 * POST /api/v1/stations/:stationId/flag-price
 * Community-reported wrong price. See src/services/priceFlagsService.js.
 * Feature-flagged via ENABLE_PRICE_FLAGS (default on).
 */
router.post('/:stationId/flag-price', priceFlagsController.flagPrice);

/**
 * GET /api/v1/stations/:id
 * Get a single station by ID
 */
router.get('/:id', stationController.getById);

module.exports = router;

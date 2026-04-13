'use strict';
const router = require('express').Router();
const stationController = require('../controllers/stationController');

/**
 * GET /api/v1/stations/nearby
 * Query params: lat, lon, radius (km), fuel_type
 */
router.get('/nearby', stationController.getNearby);

/**
 * GET /api/v1/stations/cheapest
 * Query params: lat, lon, radius (km), fuel_type
 */
router.get('/cheapest', stationController.getCheapest);

/**
 * GET /api/v1/stations/search
 * Query params: q (search term)
 */
router.get('/search', stationController.search);

/**
 * GET /api/v1/stations/:id
 * Get a single station by ID
 */
router.get('/:id', stationController.getById);

module.exports = router;

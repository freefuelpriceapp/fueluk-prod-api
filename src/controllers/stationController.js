'use strict';

const stationService = require('../services/stationService');

/**
 * stationController.js
 * HTTP controller layer for station endpoints.
 * Validates input, delegates to stationService, returns typed JSON responses.
 * Sprint 8 — refactored to use stationService instead of direct repository access.
 */

/**
 * GET /api/v1/stations/nearby
 * Query params: lat, lon, radius (miles, default 5), fuel_type
 */
async function getNearby(req, res, next) {
  try {
    const { lat, lon, radius = 5, fuel_type } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'lat and lon are required query parameters',
      });
    }

    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    const radiusNum = parseFloat(radius);

    if (isNaN(latNum) || isNaN(lonNum) || isNaN(radiusNum)) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'lat, lon, and radius must be valid numbers',
      });
    }

    const stations = await stationService.getNearbyStations({
      lat: latNum,
      lon: lonNum,
      radius: radiusNum,
      fuelType: fuel_type || null,
    });

    return res.json({
      success: true,
      count: stations.length,
      stations,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/stations/search
 * Query params: q (search term), fuel_type, limit
 */
async function search(req, res, next) {
  try {
    const { q, fuel_type, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'q must be at least 2 characters',
      });
    }

    const stations = await stationService.searchStations({
      query: q.trim(),
      fuelType: fuel_type || null,
      limit: Math.min(parseInt(limit, 10) || 20, 50),
    });

    return res.json({
      success: true,
      count: stations.length,
      stations,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/stations/:id
 * Returns full station detail with current prices.
 */
async function getById(req, res, next) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Station ID is required',
      });
    }

    const station = await stationService.getStationById(id);

    if (!station) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Station ${id} not found`,
      });
    }

    return res.json({
      success: true,
      station,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/stations/cheapest
 * Query params: lat, lon, radius, fuel_type, limit
 * Returns cheapest stations by fuel type near a location.
 */
async function getCheapest(req, res, next) {
  try {
    const { lat, lon, radius = 10, fuel_type = 'petrol', limit = 5 } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'lat and lon are required',
      });
    }

    const stations = await stationService.getCheapestNearby({
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      radius: parseFloat(radius),
      fuelType: fuel_type,
      limit: Math.min(parseInt(limit, 10) || 5, 20),
    });

    return res.json({
      success: true,
      count: stations.length,
      stations,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getNearby,
  search,
  getById,
  getCheapest,
};

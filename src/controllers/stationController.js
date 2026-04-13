/**
 * stationController.js
 * HTTP controller layer for station endpoints.
 * Validates input, calls service methods, returns typed JSON responses.
 */

const stationRepository = require('../repositories/stationRepository');

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

    const stations = await stationRepository.getNearbyStations({
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
 * Query params: q (required), lat, lon, radius, fuel_type
 */
async function search(req, res, next) {
  try {
    const { q, lat, lon, radius = 10, fuel_type } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'q (search query) is required',
      });
    }

    const stations = await stationRepository.searchStations({
      query: q.trim(),
      lat: lat ? parseFloat(lat) : null,
      lon: lon ? parseFloat(lon) : null,
      radius: radius ? parseFloat(radius) : 10,
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
 * GET /api/v1/stations/:id
 */
async function getById(req, res, next) {
  try {
    const { id } = req.params;

    if (!id || isNaN(parseInt(id, 10))) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Station id must be a valid integer',
      });
    }

    const station = await stationRepository.getStationById(parseInt(id, 10));

    if (!station) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Station ${id} not found`,
      });
    }

    return res.json({ success: true, station });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/stations/cheapest
 * Query params: lat, lon, radius, fuel_type
 */
async function getCheapest(req, res, next) {
  try {
    const { lat, lon, radius = 10, fuel_type } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'lat and lon are required',
      });
    }

    const stations = await stationRepository.getNearbyStations({
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      radius: parseFloat(radius),
      fuelType: fuel_type || null,
      orderByPrice: true,
      limit: 10,
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

module.exports = { getNearby, search, getById, getCheapest };

'use strict';

const stationService = require('../services/stationService');
const {
  deduplicateStations,
  sanitizeStationPrices,
  validateCrossFuelPrices,
  annotateStations,
  selectBestOptionIndex,
  DEFAULT_STALE_THRESHOLD_HOURS,
} = require('../utils/stationQuarantine');

function parseStaleThresholdHours(raw) {
  if (raw == null || raw === '') return DEFAULT_STALE_THRESHOLD_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_THRESHOLD_HOURS;
}

function cleanList(stations, { staleThresholdHours } = {}) {
  const sanitized = sanitizeStationPrices(stations);
  const validated = validateCrossFuelPrices(sanitized);
  const deduped = deduplicateStations(validated);
  return annotateStations(deduped, { staleThresholdHours });
}

function annotateBestOption(stations, { fuelType, radiusMiles } = {}) {
  const best = selectBestOptionIndex(stations, fuelType || 'petrol', { radiusMiles });
  if (!best) return { stations, bestOption: null, selectedReason: null };
  const next = stations.map((s, i) => {
    if (i !== best.index || !s || typeof s !== 'object') return s;
    return { ...s, is_best_option: true, selected_reason: best.reason };
  });
  return { stations: next, bestOption: next[best.index], selectedReason: best.reason };
}

/**
 * stationController.js
 * HTTP controller layer for station endpoints.
 * Sprint 8 - refactored to use stationService.
 * Sprint 12 - added brand filter + getBrands endpoint.
 */

/**
 * GET /api/v1/stations/nearby
 * Query params: lat, lon, radius (miles, default 5), fuel_type, brand
 */
async function getNearby(req, res, next) {
  try {
    const { lat, lon, fuel_type, brand } = req.query;
    const radius = req.query.radius_miles != null && req.query.radius_miles !== ''
      ? req.query.radius_miles
      : (req.query.radius != null && req.query.radius !== '' ? req.query.radius : 5);

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

    const limitNum = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const rawStations = await stationService.getNearbyStations({
      lat: latNum,
      lon: lonNum,
      radius: radiusNum,
      fuelType: fuel_type || null,
      brand: brand || null,
      limit: limitNum,
    });
    const cleaned = cleanList(rawStations, {
      staleThresholdHours: parseStaleThresholdHours(req.query.stale_threshold_hours),
    });
    const { stations, bestOption, selectedReason } = annotateBestOption(cleaned, {
      fuelType: fuel_type || 'petrol',
      radiusMiles: radiusNum,
    });

    return res.json({
      success: true,
      count: stations.length,
      stations,
      best_option: bestOption || null,
      selected_reason: selectedReason || null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/stations/brands
 * Returns distinct brand list for filter UI.
 */
async function getBrands(req, res, next) {
  try {
    const brands = await stationService.getDistinctBrands();
    return res.json({ success: true, brands });
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
    const { q, fuel_type, limit = 20, lat, lon } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'q must be at least 2 characters',
      });
    }

    const latNum = lat != null && lat !== '' ? parseFloat(lat) : null;
    const lonNum = lon != null && lon !== '' ? parseFloat(lon) : null;

    const rawStations = await stationService.searchStations({
      query: q.trim(),
      fuelType: fuel_type || null,
      limit: Math.min(parseInt(limit, 10) || 20, 50),
      lat: latNum != null && !isNaN(latNum) ? latNum : null,
      lon: lonNum != null && !isNaN(lonNum) ? lonNum : null,
    });
    const stations = cleanList(rawStations, {
      staleThresholdHours: parseStaleThresholdHours(req.query.stale_threshold_hours),
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

    const staleThresholdHours = parseStaleThresholdHours(req.query.stale_threshold_hours);
    const sanitized = sanitizeStationPrices([station]);
    const validated = validateCrossFuelPrices(sanitized);
    const [annotated] = annotateStations(validated, { staleThresholdHours });
    return res.json({ success: true, station: annotated });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/stations/cheapest
 */
async function getCheapest(req, res, next) {
  try {
    const { lat, lon, fuel_type = 'petrol', limit = 10 } = req.query;
    const radius = req.query.radius_miles != null && req.query.radius_miles !== ''
      ? req.query.radius_miles
      : (req.query.radius != null && req.query.radius !== '' ? req.query.radius : 10);

    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'lat and lon are required',
      });
    }

    const rawStations = await stationService.getCheapestNearby({
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      radius: parseFloat(radius),
      fuelType: fuel_type,
      limit: Math.min(parseInt(limit, 10) || 10, 20),
    });
    const cleaned = cleanList(rawStations, {
      staleThresholdHours: parseStaleThresholdHours(req.query.stale_threshold_hours),
    });
    const { stations, bestOption, selectedReason } = annotateBestOption(cleaned, {
      fuelType: fuel_type || 'petrol',
      radiusMiles: parseFloat(radius),
    });

    return res.json({
      success: true,
      count: stations.length,
      stations,
      best_option: bestOption || null,
      selected_reason: selectedReason || null,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getNearby,
  getBrands,
  search,
  getById,
  getCheapest,
};

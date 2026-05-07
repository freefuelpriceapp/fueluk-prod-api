'use strict';

const stationService = require('../services/stationService');
const breakEvenService = require('../services/breakEvenService');
const trajectoryService = require('../services/trajectoryService');
const communityQuarantineService = require('../services/communityQuarantineService');
const {
  deduplicateStations,
  sanitizeStationPrices,
  validateCrossFuelPrices,
  annotateStations,
  selectBestOptionIndex,
  quarantineStaleFields,
  DEFAULT_STALE_THRESHOLD_HOURS,
} = require('../utils/stationQuarantine');

function envFlag(name, defaultOn = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultOn;
  return raw === 'true' || raw === '1';
}

function parseOptionalNumber(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function annotateBreakEvenBlock(stations, { mpg, fuelType, tankFillLitres } = {}) {
  if (!envFlag('ENABLE_BREAK_EVEN', true)) {
    return { stations, bestValue: null, bestValueReason: null };
  }
  const { breakEvens, bestValue } = breakEvenService.annotateBreakEven(stations, {
    mpg,
    fuelType,
    tankFillLitres,
  });
  const withBreakEven = stations.map((s, i) => {
    if (!s || typeof s !== 'object') return s;
    const be = breakEvens[i];
    if (!be) return s;
    return { ...s, break_even: be };
  });
  let bestValueStation = null;
  let bestValueReason = null;
  if (bestValue && bestValue.index >= 0 && bestValue.index < withBreakEven.length) {
    const picked = withBreakEven[bestValue.index];
    if (picked && typeof picked === 'object') {
      bestValueStation = { ...picked, is_best_value: true };
      bestValueReason = bestValue.reason;
      withBreakEven[bestValue.index] = bestValueStation;
    }
  }
  return { stations: withBreakEven, bestValue: bestValueStation, bestValueReason };
}

async function applyCommunityQuarantineIfEnabled(stations) {
  if (!envFlag('ENABLE_PRICE_FLAGS', true)) return stations;
  try {
    return await communityQuarantineService.applyCommunityQuarantine(stations);
  } catch (err) {
    console.warn('[community-quarantine] apply failed:', err && err.message);
    return stations;
  }
}

async function annotateTrajectoryBlock(stations, { fuelType } = {}) {
  if (!envFlag('ENABLE_TRAJECTORY', true)) {
    return { stations, nationalTrajectory: null };
  }
  try {
    const { perStation, national } = await trajectoryService.annotateTrajectory(stations, {
      fuelType,
    });
    const withTrajectory = stations.map((s, i) => {
      if (!s || typeof s !== 'object') return s;
      const t = perStation[i];
      if (!t) return s;
      return { ...s, trajectory: t };
    });
    return { stations: withTrajectory, nationalTrajectory: national };
  } catch (err) {
    // Never break the endpoint on a trajectory miss — log and return as-is.
    console.warn('[trajectory] annotate failed:', err && err.message);
    return { stations, nationalTrajectory: null };
  }
}

function parseStaleThresholdHours(raw) {
  if (raw == null || raw === '') return DEFAULT_STALE_THRESHOLD_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_THRESHOLD_HOURS;
}

function cleanList(stations, { staleThresholdHours } = {}) {
  const sanitized = sanitizeStationPrices(stations);
  const validated = validateCrossFuelPrices(sanitized);
  const deduped = deduplicateStations(validated);
  // Per-field staleness gate. Critically, we run this AFTER dedup so the
  // merged record's per-field timestamps are evaluated, not the individual
  // gov/fuel_finder rows. The station is NEVER hidden — only fields are
  // quarantined per data_handling.md.
  const quarantined = quarantineStaleFields(deduped);
  return annotateStations(quarantined, { staleThresholdHours });
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
    const quarantined = await applyCommunityQuarantineIfEnabled(cleaned);
    const { stations: withBest, bestOption, selectedReason } = annotateBestOption(quarantined, {
      fuelType: fuel_type || 'petrol',
      radiusMiles: radiusNum,
    });
    const { stations: withBreakEven, bestValue, bestValueReason } = annotateBreakEvenBlock(
      withBest,
      {
        mpg: parseOptionalNumber(req.query.mpg),
        fuelType: req.query.fuel_type || 'E10',
        tankFillLitres: parseOptionalNumber(req.query.tank_fill_litres),
      },
    );
    const { stations, nationalTrajectory } = await annotateTrajectoryBlock(withBreakEven, {
      fuelType: req.query.fuel_type || 'E10',
    });

    return res.json({
      success: true,
      count: stations.length,
      stations,
      best_option: bestOption || null,
      selected_reason: selectedReason || null,
      best_value: bestValue || null,
      best_value_reason: bestValueReason || null,
      national_trajectory: nationalTrajectory || null,
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
    const fieldQuarantined = quarantineStaleFields(validated);
    const [annotated] = annotateStations(fieldQuarantined, { staleThresholdHours });
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
    const quarantined = await applyCommunityQuarantineIfEnabled(cleaned);
    const { stations: withBest, bestOption, selectedReason } = annotateBestOption(quarantined, {
      fuelType: fuel_type || 'petrol',
      radiusMiles: parseFloat(radius),
    });
    const { stations: withBreakEven, bestValue, bestValueReason } = annotateBreakEvenBlock(
      withBest,
      {
        mpg: parseOptionalNumber(req.query.mpg),
        fuelType: req.query.fuel_type || 'E10',
        tankFillLitres: parseOptionalNumber(req.query.tank_fill_litres),
      },
    );
    const { stations, nationalTrajectory } = await annotateTrajectoryBlock(withBreakEven, {
      fuelType: req.query.fuel_type || 'E10',
    });

    return res.json({
      success: true,
      count: stations.length,
      stations,
      best_option: bestOption || null,
      selected_reason: selectedReason || null,
      best_value: bestValue || null,
      best_value_reason: bestValueReason || null,
      national_trajectory: nationalTrajectory || null,
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

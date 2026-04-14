'use strict';

const stationRepository = require('../repositories/stationRepository');

/**
 * stationService.js
 * Business logic layer between stationController and stationRepository.
 * Handles geospatial queries, search orchestration, and station detail assembly.
 */

const MILES_TO_KM = 1.60934;

/**
 * Get stations near a given lat/lng within radius miles.
 * Applies fuel type filter if provided.
 */
async function getNearbyStations({ lat, lon, radius = 5, fuelType }) {
  const radiusKm = parseFloat(radius) * MILES_TO_KM;
  const stations = await stationRepository.getNearbyStations({
    lat,
    lng: lon,
    radiusKm,
    fuel: fuelType || 'petrol',
  });
  return stations.map(formatStation);
}

/**
 * Search stations by postcode, town, or place name.
 * Falls back to a name/postcode ILIKE match.
 */
async function searchStations({ query, fuelType, limit = 20 }) {
  const stations = await stationRepository.searchStations({ query, fuelType, limit });
  return stations.map(formatStation);
}

/**
 * Get a single station by ID with full price detail.
 */
async function getStationById(id) {
  const station = await stationRepository.getStationById(id);
  if (!station) return null;
  return formatStation(station);
}

/**
 * Get the cheapest stations for a given fuel type near a location.
 * Used for route-aware recommendations (future: route intelligence).
 */
async function getCheapestNearby({ lat, lon, radius = 10, fuelType = 'petrol', limit = 5 }) {
  const radiusKm = parseFloat(radius) * MILES_TO_KM;
  const stations = await stationRepository.getNearbyStations({
    lat,
    lng: lon,
    radiusKm,
    fuel: fuelType,
    limit,
  });
  return stations.map(formatStation);
}

/**
 * Format a raw DB station row into a clean public API shape.
 */
function formatStation(row) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    address: row.address,
    postcode: row.postcode,
    lat: parseFloat(row.lat),
    lon: parseFloat(row.lng || row.lon),
    petrol_price: row.petrol_price ? parseFloat(row.petrol_price) : null,
    diesel_price: row.diesel_price ? parseFloat(row.diesel_price) : null,
    e10_price: row.e10_price ? parseFloat(row.e10_price) : null,
    last_updated: row.last_updated || null,
    distance_miles: row.distance_m ? parseFloat((row.distance_m / 1609.34).toFixed(2)) : null,
  };
}

module.exports = { getNearbyStations, searchStations, getStationById, getCheapestNearby };

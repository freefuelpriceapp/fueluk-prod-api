'use strict';

const stationRepository = require('../repositories/stationRepository');

/**
 * stationService.js
 * Business logic layer between stationController and stationRepository.
 * Sprint 12 - added brand filter + getDistinctBrands.
 */

const MILES_TO_KM = 1.60934;
const DEFAULT_SEARCH_RADIUS_KM = 16;

const UK_FULL_POSTCODE_RE = /\b(GIR\s*0AA|[A-PR-UWYZ]([0-9]{1,2}|[A-HK-Y][0-9]|[A-HK-Y][0-9]([0-9]|[ABEHMNPRV-Y]))\s*[0-9][ABD-HJLNP-UW-Z]{2})\b/i;
const UK_OUTCODE_RE = /\b([A-PR-UWYZ]([0-9]{1,2}|[A-HK-Y][0-9]|[A-HK-Y][0-9]([0-9]|[ABEHMNPRV-Y])))\b/i;

async function getNearbyStations({ lat, lon, radius = 5, fuelType, brand, limit = 50 }) {
  const radiusKm = parseFloat(radius) * MILES_TO_KM;
  const stations = await stationRepository.getNearbyStations({
    lat, lng: lon, radiusKm, fuel: fuelType || 'petrol', brand: brand || null, limit,
  });
  return stations.map(formatStation);
}

async function getDistinctBrands() {
  if (typeof stationRepository.getDistinctBrands === 'function') {
    return stationRepository.getDistinctBrands();
  }
  return [];
}

async function searchStations({ query, fuelType, limit = 20, lat = null, lon = null }) {
  const raw = (query || '').trim();
  if (!raw) return [];

  const latNum = lat != null && !isNaN(Number(lat)) ? Number(lat) : null;
  const lngNum = lon != null && !isNaN(Number(lon)) ? Number(lon) : null;

  const full = raw.match(UK_FULL_POSTCODE_RE);
  if (full) {
    const geo = await geocodePostcode(full[0]);
    if (geo) return nearbyFromPoint(geo, fuelType, limit);
  }

  const out = raw.match(UK_OUTCODE_RE);
  if (out && out[0].length <= 4) {
    const geo = await geocodeOutcode(out[0]);
    if (geo) return nearbyFromPoint(geo, fuelType, limit);
  }

  const tokens = raw.split(/\s+/).filter(t => t.length >= 2).slice(0, 5);
  if (tokens.length && typeof stationRepository.searchStationsTokens === 'function') {
    const rows = await stationRepository.searchStationsTokens({
      tokens, fuelType, limit, lat: latNum, lng: lngNum,
    });
    if (rows && rows.length) return rows.map(formatStation);
  }

  const place = await geocodePlace(raw);
  if (place) return nearbyFromPoint(place, fuelType, limit);

  const legacy = await stationRepository.searchStations({
    query: raw, fuelType, limit, lat: latNum, lng: lngNum,
  });
  return (legacy || []).map(formatStation);
}

async function getStationById(id) {
  const station = await stationRepository.getStationById(id);
  if (!station) return null;
  return formatStation(station);
}

async function getCheapestNearby({ lat, lon, radius = 10, fuelType = 'petrol', limit = 10 }) {
  const radiusKm = parseFloat(radius) * MILES_TO_KM;
  const stations = await stationRepository.getNearbyStations({
    lat, lng: lon, radiusKm, fuel: fuelType, limit,
  });
  return stations.map(formatStation);
}

async function geocodePostcode(pc) {
  const clean = pc.replace(/\s+/g, '').toUpperCase();
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (json && json.result && json.result.latitude != null) {
      return { lat: json.result.latitude, lng: json.result.longitude, label: json.result.postcode };
    }
  } catch (_e) { /* ignore */ }
  return null;
}

async function geocodeOutcode(outcode) {
  const clean = outcode.replace(/\s+/g, '').toUpperCase();
  try {
    const res = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(clean)}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (json && json.result && json.result.latitude != null) {
      return { lat: json.result.latitude, lng: json.result.longitude, label: json.result.outcode };
    }
  } catch (_e) { /* ignore */ }
  return null;
}

async function geocodePlace(q) {
  try {
    const res = await fetch(`https://api.postcodes.io/places?q=${encodeURIComponent(q)}&limit=1`);
    if (!res.ok) return null;
    const json = await res.json();
    const hit = json && json.result && json.result[0];
    if (hit && hit.latitude != null) {
      return { lat: hit.latitude, lng: hit.longitude, label: hit.name_1 };
    }
  } catch (_e) { /* ignore */ }
  return null;
}

async function nearbyFromPoint({ lat, lng }, fuelType, limit) {
  const stations = await stationRepository.getNearbyStations({
    lat, lng, radiusKm: DEFAULT_SEARCH_RADIUS_KM,
    fuel: fuelType || 'petrol', limit,
  });
  return stations.map(formatStation);
}

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
    super_unleaded_price: row.super_unleaded_price != null ? parseFloat(row.super_unleaded_price) : null,
    premium_diesel_price: row.premium_diesel_price != null ? parseFloat(row.premium_diesel_price) : null,
    petrol_source: row.petrol_source || 'gov',
    diesel_source: row.diesel_source || 'gov',
    e10_source: row.e10_source || 'gov',
    super_unleaded_source: row.super_unleaded_source || null,
    premium_diesel_source: row.premium_diesel_source || null,
    last_updated: row.last_updated || null,
    opening_hours: row.opening_hours || null,
    amenities: row.amenities || [],
    is_motorway: row.is_motorway || false,
    is_supermarket: row.is_supermarket || false,
    temporary_closure: row.temporary_closure || false,
    permanent_closure: row.permanent_closure || false,
    fuel_types: row.fuel_types || [],
    distance_miles: row.distance_m ? parseFloat((row.distance_m / 1609.34).toFixed(2)) : null,
  };
}

module.exports = { getNearbyStations, getDistinctBrands, searchStations, getStationById, getCheapestNearby };

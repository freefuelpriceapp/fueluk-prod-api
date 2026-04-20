'use strict';
const router = require('express').Router();
const { getPool } = require('../config/db');

/**
 * Sprint 2 — Trip Cost Calculator
 * POST /api/v1/trip/calculate
 *
 * Inputs: origin/destination coordinates, vehicle MPG, fuel type, tank size.
 * Finds the cheapest station near the route midpoint (Haversine * road
 * factor) and returns projected fuel use, cost, CO2 emissions, and
 * per-passenger splits.
 *
 * No routing API — straight-line distance times 1.3 gives a workable road
 * estimate that's within ~10% for typical UK motorway/A-road trips.
 */

const EARTH_RADIUS_MILES = 3958.8;
const ROAD_DISTANCE_FACTOR = 1.3;
const LITRES_PER_UK_GALLON = 4.54609;
// Typical CO2 (kg) per litre burned: petrol ≈ 2.31, diesel ≈ 2.68.
const CO2_KG_PER_LITRE = { petrol: 2.31, e10: 2.31, diesel: 2.68, super_unleaded: 2.31, premium_diesel: 2.68 };
// Max radius around the route midpoint when searching for a cheap station.
const MIDPOINT_SEARCH_RADIUS_METRES = 40000; // ~25 miles

const FUEL_TYPE_TO_COLUMN = {
  petrol: 'e10_price',
  e10: 'e10_price',
  diesel: 'diesel_price',
  super_unleaded: 'super_unleaded_price',
  premium_diesel: 'premium_diesel_price',
};

function toRad(deg) { return (deg * Math.PI) / 180; }

function haversineMiles(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function findCheapestNearMidpoint(pool, midLat, midLon, fuelType) {
  const priceCol = FUEL_TYPE_TO_COLUMN[fuelType] || 'e10_price';
  const { rows } = await pool.query(
    `SELECT id, name, brand, address, postcode, lat, lng,
            ${priceCol} AS price
       FROM stations
      WHERE ${priceCol} IS NOT NULL
        AND (temporary_closure IS NOT TRUE)
        AND (permanent_closure IS NOT TRUE)
        AND location IS NOT NULL
        AND ST_DWithin(
              location,
              ST_SetSRID(ST_MakePoint($1, $2), 4326)::GEOGRAPHY,
              $3
            )
      ORDER BY ${priceCol} ASC
      LIMIT 1`,
    [midLon, midLat, MIDPOINT_SEARCH_RADIUS_METRES]
  );
  return rows[0] || null;
}

// POST /api/v1/trip/calculate
router.post('/calculate', async (req, res, next) => {
  try {
    const {
      origin_lat,
      origin_lon,
      destination_lat,
      destination_lon,
      vehicle_mpg,
      fuel_type,
      tank_size_litres,
    } = req.body || {};

    const oLat = numberOrNull(origin_lat);
    const oLon = numberOrNull(origin_lon);
    const dLat = numberOrNull(destination_lat);
    const dLon = numberOrNull(destination_lon);
    const mpg = numberOrNull(vehicle_mpg);
    const tank = numberOrNull(tank_size_litres);

    if (oLat === null || oLon === null || dLat === null || dLon === null) {
      return res.status(400).json({ error: 'origin_lat, origin_lon, destination_lat, destination_lon are required' });
    }
    if (mpg === null || mpg <= 0) {
      return res.status(400).json({ error: 'vehicle_mpg must be a positive number' });
    }
    const fuelTypeKey = (fuel_type || 'petrol').toLowerCase();
    if (!FUEL_TYPE_TO_COLUMN[fuelTypeKey]) {
      return res.status(400).json({ error: `fuel_type must be one of: ${Object.keys(FUEL_TYPE_TO_COLUMN).join(', ')}` });
    }

    const straightLineMiles = haversineMiles(oLat, oLon, dLat, dLon);
    const distanceMiles = Math.round(straightLineMiles * ROAD_DISTANCE_FACTOR * 10) / 10;

    const midLat = (oLat + dLat) / 2;
    const midLon = (oLon + dLon) / 2;

    const pool = getPool();
    const cheapest = await findCheapestNearMidpoint(pool, midLat, midLon, fuelTypeKey);

    // Fuel needed (UK MPG → imperial gallons → litres).
    const gallonsNeeded = distanceMiles / mpg;
    const fuelNeededLitres = Math.round(gallonsNeeded * LITRES_PER_UK_GALLON * 10) / 10;

    const pricePpl = cheapest && cheapest.price != null ? Number(cheapest.price) : null;
    const estimatedCostPence = pricePpl !== null
      ? Math.round(fuelNeededLitres * pricePpl)
      : null;
    const estimatedCostPounds = estimatedCostPence !== null ? estimatedCostPence / 100 : null;

    const co2PerLitre = CO2_KG_PER_LITRE[fuelTypeKey] || 2.31;
    const co2Kg = Math.round(fuelNeededLitres * co2PerLitre * 10) / 10;

    const pounds = (pence) => `£${(pence / 100).toFixed(2)}`;
    const costPerPassenger = estimatedCostPence !== null
      ? {
          2: pounds(estimatedCostPence / 2),
          3: pounds(estimatedCostPence / 3),
          4: pounds(estimatedCostPence / 4),
        }
      : null;

    const tankWarning = tank !== null && fuelNeededLitres > tank
      ? `Trip requires ${fuelNeededLitres}L but tank holds ${tank}L — expect at least one refuel.`
      : null;

    return res.json({
      distance_miles: distanceMiles,
      fuel_needed_litres: fuelNeededLitres,
      cheapest_price_ppl: pricePpl,
      estimated_cost: estimatedCostPounds !== null ? `£${estimatedCostPounds.toFixed(2)}` : null,
      estimated_cost_pence: estimatedCostPence,
      co2_kg: co2Kg,
      cheapest_station: cheapest
        ? {
            id: cheapest.id,
            name: cheapest.name,
            brand: cheapest.brand,
            address: cheapest.address,
            postcode: cheapest.postcode,
            lat: cheapest.lat == null ? null : Number(cheapest.lat),
            lng: cheapest.lng == null ? null : Number(cheapest.lng),
            price: pricePpl,
          }
        : null,
      cost_per_passenger: costPerPassenger,
      tank_warning: tankWarning,
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.haversineMiles = haversineMiles;

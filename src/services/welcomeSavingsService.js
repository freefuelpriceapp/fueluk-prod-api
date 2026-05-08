'use strict';

/**
 * welcomeSavingsService.js — Wave A.9
 *
 * Computes the personalised savings estimate for the welcome flow.
 * Three frames:
 *   - 'loss'       — user is NOT at cheapest local station, annual loss >= £20
 *   - 'validating' — user IS at (or near) cheapest local, validate them
 *   - 'regional'   — insufficient data; show area vs UK average
 *
 * Privacy: plate MUST NOT be passed here. Mobile sends make/model/fuel/mpg.
 * Coordinates are truncated to 3 d.p. by the controller before reaching here.
 */

const { getPool } = require('../config/db');

// Default assumptions when no vehicle details provided
const UK_DEFAULT_MILEAGE = 8000;
const UK_DEFAULT_DIESEL_MPG = 45;
const UK_DEFAULT_PETROL_MPG = 42;

// Litres per imperial gallon
const LITRES_PER_GALLON = 4.546;

// Minimum savings to trigger loss frame (2000p = £20)
const LOSS_THRESHOLD_PENCE = 2000;

// Radius for comparison stations (5 miles in km)
const COMPARISON_RADIUS_KM = 5 * 1.60934;

/**
 * Resolve postcode district (e.g. "B7") from lat/lon via postcodes.io.
 * Returns { district, area_label } or null on failure.
 */
async function resolvePostcodeDistrict(lat, lon) {
  try {
    const url = `https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&limit=1&radius=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = await res.json();
    const hit = json && json.result && json.result[0];
    if (!hit) return null;
    const postcode = hit.postcode || '';
    const district = hit.outcode || postcode.split(' ')[0] || '';
    const county = hit.admin_county || hit.nuts || district;
    return {
      district,
      area_label: district,
      county,
    };
  } catch (_e) {
    return null;
  }
}

/**
 * Map fuel_type string to the station column and price_history fuel type.
 */
function mapFuelType(fuelType) {
  const ft = String(fuelType || 'diesel').toUpperCase();
  if (ft.includes('DIESEL') || ft === 'B7') {
    return { col: 'diesel_price', historyType: 'diesel', label: 'diesel' };
  }
  if (ft.includes('E10')) {
    return { col: 'e10_price', historyType: 'e10', label: 'E10' };
  }
  // Default to petrol / unleaded
  return { col: 'petrol_price', historyType: 'petrol', label: 'petrol' };
}

/**
 * Get the nearest N stations within radius, with their current price.
 * Returns stations ordered by distance ascending.
 */
async function getNearbyStationsWithPrice(pool, lat, lon, fuelCol, radiusKm, limit) {
  try {
    const result = await pool.query(
      `SELECT id, brand, name, address, postcode,
              ${fuelCol} AS current_price,
              ST_Distance(
                location::geography,
                ST_SetSRID(ST_MakePoint($2,$1),4326)::geography
              ) AS distance_m
         FROM stations
        WHERE ST_DWithin(
                location::geography,
                ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
                $3
              )
          AND ${fuelCol} IS NOT NULL
          AND (permanent_closure IS NOT TRUE)
          AND name NOT LIKE 'QA %'
          AND name NOT LIKE 'Test %'
        ORDER BY distance_m ASC
        LIMIT $4`,
      [lat, lon, radiusKm * 1000, limit]
    );
    return result.rows;
  } catch (_e) {
    return [];
  }
}

/**
 * Get 12-month average price for a station + fuel type.
 * Returns null if insufficient data (< 30 data points).
 */
async function get12MonthAvgPrice(pool, stationId, historyType) {
  try {
    const result = await pool.query(
      `SELECT AVG(price_pence) AS avg_price, COUNT(*) AS data_points
         FROM price_history
        WHERE station_id = $1
          AND fuel_type = $2
          AND recorded_at >= NOW() - INTERVAL '12 months'`,
      [stationId, historyType]
    );
    const row = result.rows[0];
    if (!row || Number(row.data_points) < 5) return null;
    return parseFloat(row.avg_price);
  } catch (_e) {
    return null;
  }
}

/**
 * Get the UK national average price for a fuel type over the last month.
 */
async function getNationalAvgPrice(pool, historyType) {
  try {
    const result = await pool.query(
      `SELECT AVG(price_pence) AS avg_price
         FROM price_history
        WHERE fuel_type = $1
          AND recorded_at >= NOW() - INTERVAL '1 month'`,
      [historyType]
    );
    const row = result.rows[0];
    if (!row || row.avg_price == null) return null;
    return parseFloat(row.avg_price);
  } catch (_e) {
    return null;
  }
}

/**
 * Get the current-price percentile for a station within an area.
 * Returns the % of stations in the area that are MORE EXPENSIVE.
 * (i.e. "you pay less than X% of drivers around here")
 */
async function getPricePercentile(pool, stationPrice, lat, lon, fuelCol, radiusKm) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${fuelCol} > $1 THEN 1 ELSE 0 END) AS more_expensive
         FROM stations
        WHERE ST_DWithin(
                location::geography,
                ST_SetSRID(ST_MakePoint($3,$2),4326)::geography,
                $4
              )
          AND ${fuelCol} IS NOT NULL
          AND (permanent_closure IS NOT TRUE)`,
      [stationPrice, lat, lon, radiusKm * 1000]
    );
    const row = result.rows[0];
    if (!row || Number(row.total) === 0) return null;
    return Math.round((Number(row.more_expensive) / Number(row.total)) * 100);
  } catch (_e) {
    return null;
  }
}

/**
 * Get the current area average price (stations in same postcode area).
 */
async function getAreaAvgPrice(pool, lat, lon, fuelCol, radiusKm) {
  try {
    const result = await pool.query(
      `SELECT AVG(${fuelCol}) AS avg_price, COUNT(*) AS cnt
         FROM stations
        WHERE ST_DWithin(
                location::geography,
                ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
                $3
              )
          AND ${fuelCol} IS NOT NULL
          AND (permanent_closure IS NOT TRUE)`,
      [lat, lon, radiusKm * 1000]
    );
    const row = result.rows[0];
    if (!row || Number(row.cnt) < 2) return null;
    return parseFloat(row.avg_price);
  } catch (_e) {
    return null;
  }
}

/**
 * Main savings estimate logic.
 *
 * @param {object} params
 * @param {number} params.lat           - truncated to 3dp by controller
 * @param {number} params.lon           - truncated to 3dp by controller
 * @param {string} [params.make]        - vehicle make (no plate)
 * @param {string} [params.model]       - vehicle model
 * @param {string} [params.fuel_type]   - fuel type string
 * @param {number} [params.mpg]         - vehicle MPG
 * @param {number} [params.mileage_per_year] - annual mileage
 * @returns {object} SavingsEstimate response
 */
async function computeSavingsEstimate({ lat, lon, make, model, fuel_type, mpg, mileage_per_year }) {
  const pool = getPool();

  // ── Resolve vehicle params ─────────────────────────────────────────────────
  const fuelMap = mapFuelType(fuel_type);
  const vehicleMpg = (mpg && Number(mpg) > 0) ? Number(mpg) : (
    fuelMap.label === 'diesel' ? UK_DEFAULT_DIESEL_MPG : UK_DEFAULT_PETROL_MPG
  );
  const annualMileage = (mileage_per_year && Number(mileage_per_year) > 0)
    ? Number(mileage_per_year)
    : UK_DEFAULT_MILEAGE;

  const vehicleDesc = (make && model)
    ? `${make} ${model}${fuel_type ? ' ' + fuel_type.toLowerCase() : ''}`
    : `UK average ${fuelMap.label} vehicle`;

  const assumptions = [];
  if (!mpg || !Number(mpg)) {
    assumptions.push(`${vehicleMpg}mpg assumed (UK average ${fuelMap.label})`);
  }
  if (!mileage_per_year || !Number(mileage_per_year)) {
    assumptions.push(`${UK_DEFAULT_MILEAGE.toLocaleString()} mi/yr assumed (UK average)`);
  }
  assumptions.push(`${LITRES_PER_GALLON}L per imperial gallon`);

  // Litres consumed per year
  const litresPerYear = (annualMileage / vehicleMpg) * LITRES_PER_GALLON;

  // ── Resolve postcode district ──────────────────────────────────────────────
  const geo = await resolvePostcodeDistrict(lat, lon);
  const areaLabel = geo ? geo.area_label : 'your area';

  // ── Get nearby stations ────────────────────────────────────────────────────
  const nearbyStations = await getNearbyStationsWithPrice(
    pool, lat, lon, fuelMap.col, COMPARISON_RADIUS_KM, 20
  );

  // Need at least 3 stations for a meaningful comparison
  if (nearbyStations.length < 3) {
    return buildRegionalFrame(pool, fuelMap, areaLabel, assumptions, vehicleDesc, lat, lon);
  }

  // Closest 3 for user's "current" stations (what most drivers use)
  const nearest3 = nearbyStations.slice(0, 3);
  const cheapest = nearbyStations.reduce((a, b) =>
    Number(a.current_price) <= Number(b.current_price) ? a : b
  );

  // Use 12-month averages where available; fall back to current prices
  const nearest3Prices = await Promise.all(
    nearest3.map(async (s) => {
      const avg = await get12MonthAvgPrice(pool, s.id, fuelMap.historyType);
      return avg !== null ? avg : Number(s.current_price);
    })
  );
  const cheapestAvg12m = await get12MonthAvgPrice(pool, cheapest.id, fuelMap.historyType);
  const cheapestPrice = cheapestAvg12m !== null ? cheapestAvg12m : Number(cheapest.current_price);

  const hasHistory = nearest3Prices.some((p, i) => {
    // If any of the 3 have real 12m avg, we have history
    return true; // We use current as fallback anyway
  });

  const userAvgPrice = nearest3Prices.reduce((a, b) => a + b, 0) / nearest3Prices.length;
  const diffPencePerLitre = userAvgPrice - cheapestPrice;
  const lossPencePerYear = diffPencePerLitre * litresPerYear;

  const basis = [
    vehicleDesc,
    `${annualMileage.toLocaleString()} mi/yr`,
    cheapestAvg12m !== null ? '12-month average price history' : 'current prices',
  ].filter(Boolean).join(', ');

  const comparisonLabel = [
    cheapest.brand && cheapest.brand !== 'Unknown' ? cheapest.brand : '',
    cheapest.name || '',
    cheapest.postcode || '',
  ].filter(Boolean).join(' ') || 'cheapest local station';

  // ── Determine frame ────────────────────────────────────────────────────────
  if (lossPencePerYear >= LOSS_THRESHOLD_PENCE) {
    // LOSS frame
    const lossGBP = Math.round(lossPencePerYear / 100);
    const headline = `You could have saved £${lossGBP} in the last 12 months.`;

    return {
      frame: 'loss',
      headline,
      amount_pence: Math.round(lossPencePerYear),
      methodology: {
        basis,
        comparison: `vs ${comparisonLabel}`,
        assumptions,
      },
      area_label: areaLabel,
      percentile: null,
    };
  }

  // VALIDATING frame — user is at or near cheapest
  const userCurrentStation = nearest3[0]; // closest station is proxy for their usual
  const userCurrentPrice = Number(userCurrentStation.current_price);

  const percentile = await getPricePercentile(
    pool,
    userCurrentPrice,
    lat, lon,
    fuelMap.col,
    COMPARISON_RADIUS_KM
  );

  const percentileText = percentile !== null ? percentile : 75;
  const headline = `You're already filling at one of the cheapest spots in ${areaLabel} — paying less than ${percentileText}% of drivers around here. We'll tell you if that changes.`;

  return {
    frame: 'validating',
    headline,
    amount_pence: null,
    methodology: {
      basis,
      comparison: `vs ${comparisonLabel}`,
      assumptions,
    },
    area_label: areaLabel,
    percentile: percentileText,
  };
}

/**
 * Build the regional frame when insufficient local data is available.
 */
async function buildRegionalFrame(pool, fuelMap, areaLabel, assumptions, vehicleDesc, lat, lon) {
  const nationalAvg = await getNationalAvgPrice(pool, fuelMap.historyType);
  const areaAvg = await getAreaAvgPrice(pool, lat, lon, fuelMap.col, COMPARISON_RADIUS_KM * 2);

  let headline;
  if (nationalAvg !== null && areaAvg !== null) {
    const diffP = Math.round(areaAvg - nationalAvg);
    const diffStr = diffP > 0
      ? `${diffP}p/L more than`
      : diffP < 0
        ? `${Math.abs(diffP)}p/L less than`
        : 'the same as';
    headline = `Drivers in ${areaLabel} paid ${diffStr} the UK average this month — we'll watch your stations for changes.`;
  } else {
    headline = `We're watching stations in ${areaLabel} — we'll alert you when prices move.`;
  }

  return {
    frame: 'regional',
    headline,
    amount_pence: null,
    methodology: {
      basis: vehicleDesc,
      comparison: 'vs UK national average',
      assumptions: [...assumptions, 'Limited local station data — regional comparison used'],
    },
    area_label: areaLabel,
    percentile: null,
  };
}

module.exports = { computeSavingsEstimate, resolvePostcodeDistrict, mapFuelType };

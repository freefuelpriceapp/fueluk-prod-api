'use strict';

/**
 * breakEvenService.js
 * Pure functions to compute per-station net fuel cost including a detour
 * penalty, and pick the station with the best £ savings vs the nearest in
 * the result. See FEATUREFLAGS.md (ENABLE_BREAK_EVEN) for on/off control.
 */

const UK_GALLON_LITRES = 4.546;
const WORTH_THE_DRIVE_THRESHOLD_GBP = 0.10;

// UK average mpg used when the caller does not provide a vehicle mpg.
const DEFAULT_MPG_BY_FUEL = {
  petrol: 45,
  e10: 45,
  b7: 55,
  diesel: 55,
  e5: 42,
  super_unleaded: 40,
  premium_diesel: 55,
};

const MPG_SOURCE_KEYS = {
  petrol: 'default_e10',
  e10: 'default_e10',
  b7: 'default_b7',
  diesel: 'default_b7',
  e5: 'default_e5',
  super_unleaded: 'default_super_unleaded',
  premium_diesel: 'default_b7',
};

// Map public fuel_type query strings onto the canonical station price field
// and default mpg key. Accepts mixed case + common synonyms.
const FUEL_TYPE_ALIASES = {
  E10: { key: 'e10', priceField: 'e10_price' },
  PETROL: { key: 'petrol', priceField: 'petrol_price' },
  E5: { key: 'e5', priceField: 'petrol_price' },
  SUPER_UNLEADED: { key: 'super_unleaded', priceField: 'super_unleaded_price' },
  B7: { key: 'b7', priceField: 'diesel_price' },
  DIESEL: { key: 'diesel', priceField: 'diesel_price' },
  PREMIUM_DIESEL: { key: 'premium_diesel', priceField: 'premium_diesel_price' },
};

function resolveFuel(fuelType) {
  const key = String(fuelType || 'E10').toUpperCase();
  return FUEL_TYPE_ALIASES[key] || FUEL_TYPE_ALIASES.E10;
}

/**
 * Coerce numeric inputs. Returns null when the input is not a finite number.
 */
function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute break-even fields for a single station. Pure — no I/O.
 *
 * Inputs:
 *   station: must have { distance_miles, <priceField> }
 *   opts.mpg: user-supplied mpg (optional)
 *   opts.fuelType: "E10"|"B7"|... (default E10)
 *   opts.tankFillLitres: typical fill used for £ calc (default 40)
 *
 * Returns null when the station has no usable price — caller omits the
 * block entirely in that case.
 */
function computeBreakEvenForStation(station, opts = {}) {
  if (!station || typeof station !== 'object') return null;

  const { key: fuelKey, priceField } = resolveFuel(opts.fuelType);
  const pricePerLitre = toNumber(station[priceField]);
  if (pricePerLitre == null) return null;

  const tankFillLitres = toNumber(opts.tankFillLitres);
  const tankFill = tankFillLitres != null && tankFillLitres > 0 ? tankFillLitres : 40;

  const distanceMiles = toNumber(station.distance_miles);
  // Without distance the detour term is zero — still useful to compute fuel cost.
  const detourDistanceMiles = distanceMiles != null && distanceMiles >= 0
    ? 2 * distanceMiles
    : 0;

  const userMpg = toNumber(opts.mpg);
  let mpgUsed;
  let mpgSource;
  if (userMpg != null && userMpg > 0) {
    mpgUsed = userMpg;
    mpgSource = 'user';
  } else {
    mpgUsed = DEFAULT_MPG_BY_FUEL[fuelKey] || DEFAULT_MPG_BY_FUEL.e10;
    mpgSource = MPG_SOURCE_KEYS[fuelKey] || 'default_e10';
  }

  // price_per_litre is in pence; £ cost = litres × pence/100
  const fuelCostFullTank = (tankFill * pricePerLitre) / 100;

  // Detour cost: (miles / mpg) gallons × litres/gallon × price/100 = £
  const detourCost = mpgUsed > 0
    ? (detourDistanceMiles / mpgUsed) * (pricePerLitre * UK_GALLON_LITRES) / 100
    : 0;

  const netCost = fuelCostFullTank + detourCost;

  return {
    fuel_cost_full_tank: round2(fuelCostFullTank),
    detour_cost: round2(detourCost),
    net_cost: round2(netCost),
    // savings_vs_nearest filled in by annotateBreakEven once we know the
    // anchor station.
    savings_vs_nearest: 0,
    savings_vs_nearest_formatted: '',
    worth_the_drive: false,
    mpg_used: mpgUsed,
    mpg_source: mpgSource,
    tank_fill_litres: tankFill,
    // Internal: keep raw net for downstream comparisons; stripped before
    // sending to clients.
    _net_cost_raw: netCost,
    _detour_distance_miles: detourDistanceMiles,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatSavings(savings) {
  if (!Number.isFinite(savings)) return '';
  const abs = Math.abs(savings);
  const sign = savings >= 0 ? '+' : '-';
  if (savings >= WORTH_THE_DRIVE_THRESHOLD_GBP) {
    return `${sign}£${abs.toFixed(2)} saved vs nearest`;
  }
  if (savings <= -WORTH_THE_DRIVE_THRESHOLD_GBP) {
    return `${sign}£${abs.toFixed(2)} vs nearest`;
  }
  return `±£${abs.toFixed(2)} vs nearest`;
}

/**
 * Given an already-computed list of break-even objects (or null), find the
 * "nearest" anchor (smallest distance_miles among stations that have a
 * break-even block) and fill in savings_vs_nearest + worth_the_drive for
 * each.
 *
 * Returns a new array of the same length with strip()'d per-station blocks
 * plus the anchor station's raw net cost for downstream.
 */
function applySavingsVsNearest(stations, breakEvens) {
  if (!Array.isArray(stations) || !Array.isArray(breakEvens)) {
    return { breakEvens: [], nearestNetCost: null };
  }

  // Pick the "nearest" station that has a break-even block as the anchor.
  let anchorIdx = -1;
  let anchorDistance = Infinity;
  for (let i = 0; i < stations.length; i += 1) {
    const be = breakEvens[i];
    if (!be) continue;
    const dist = toNumber(stations[i] && stations[i].distance_miles);
    const d = dist != null ? dist : Infinity;
    if (d < anchorDistance) {
      anchorDistance = d;
      anchorIdx = i;
    }
  }

  const anchor = anchorIdx >= 0 ? breakEvens[anchorIdx] : null;
  const anchorNet = anchor ? anchor._net_cost_raw : null;

  const result = breakEvens.map((be) => {
    if (!be) return null;
    const rawSavings = anchorNet != null ? anchorNet - be._net_cost_raw : 0;
    const savings = round2(rawSavings);
    const worth = savings >= WORTH_THE_DRIVE_THRESHOLD_GBP;
    const { _net_cost_raw, _detour_distance_miles, ...publicFields } = be;
    return {
      ...publicFields,
      savings_vs_nearest: savings,
      savings_vs_nearest_formatted: formatSavings(savings),
      worth_the_drive: worth,
    };
  });

  return { breakEvens: result, nearestNetCost: anchorNet };
}

/**
 * Find the index of the station with the highest raw savings (biggest
 * net-£ win over the nearest). Different from selectBestOptionIndex which
 * is cheapest-per-litre + distance.
 *
 * Returns { index, reason, savings } or null when no station qualifies.
 */
function selectBestValueIndex(stations, breakEvens) {
  if (!Array.isArray(stations) || !Array.isArray(breakEvens)) return null;
  if (stations.length !== breakEvens.length) return null;

  let bestIdx = -1;
  let bestSavings = -Infinity;
  for (let i = 0; i < breakEvens.length; i += 1) {
    const be = breakEvens[i];
    if (!be) continue;
    const s = be.savings_vs_nearest;
    if (!Number.isFinite(s)) continue;
    // Ignore stations that are worse than the anchor or inside the noise band.
    if (s < WORTH_THE_DRIVE_THRESHOLD_GBP) continue;
    if (s > bestSavings) {
      bestSavings = s;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return null;
  const dist = toNumber(stations[bestIdx] && stations[bestIdx].distance_miles);
  const distLabel = dist != null ? `${dist.toFixed(1)}mi` : 'short';
  return {
    index: bestIdx,
    savings: bestSavings,
    reason: `Saves £${bestSavings.toFixed(2)} net after ${distLabel} detour`,
  };
}

/**
 * High-level wrapper: compute per-station break-even + apply nearest-anchor
 * savings + find best-value station. Returns:
 *   { breakEvens: [per-station block|null], bestValue: {index, reason, savings}|null }
 */
function annotateBreakEven(stations, opts = {}) {
  if (!Array.isArray(stations) || !stations.length) {
    return { breakEvens: [], bestValue: null };
  }
  const rawBlocks = stations.map((s) => computeBreakEvenForStation(s, opts));
  const { breakEvens } = applySavingsVsNearest(stations, rawBlocks);
  const bestValue = selectBestValueIndex(stations, breakEvens);
  return { breakEvens, bestValue };
}

module.exports = {
  computeBreakEvenForStation,
  applySavingsVsNearest,
  selectBestValueIndex,
  annotateBreakEven,
  DEFAULT_MPG_BY_FUEL,
  UK_GALLON_LITRES,
  WORTH_THE_DRIVE_THRESHOLD_GBP,
};

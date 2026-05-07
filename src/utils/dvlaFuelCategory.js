'use strict';

/**
 * dvlaFuelCategory.js
 * Wave A.8 — Authoritative DVLA fuel-type taxonomy helpers.
 *
 * Converts the raw DVLA `fuelType` string (e.g. "DIESEL", "HYBRID ELECTRIC")
 * into two normalised representations:
 *
 *   fuel_type      — lowercased copy of the raw value ("diesel", "petrol", …)
 *   fuel_category  — canonical taxonomy key used by the mobile app for price
 *                    lookups: 'diesel' | 'unleaded' | 'electric' | null
 *
 * Mapping rules (case-insensitive matching):
 *   DIESEL                         → 'diesel'
 *   PETROL, GASOLINE               → 'unleaded'
 *   HYBRID ELECTRIC, HYBRID, PHEV,
 *   PETROL/ELECTRIC                → 'unleaded'  (hybrids burn 95-RON at the pump)
 *   ELECTRICITY, ELECTRIC, EV, BEV → 'electric'
 *   anything else / empty / null   → null        (mobile keeps user choice)
 */

/**
 * Map a raw DVLA fuelType string to the canonical mobile taxonomy key.
 *
 * @param {string|null|undefined} rawFuelType - The fuelType string as returned by DVLA VES.
 * @returns {'diesel'|'unleaded'|'electric'|null}
 */
function mapDvlaToFuelCategory(rawFuelType) {
  if (!rawFuelType || typeof rawFuelType !== 'string') return null;
  const upper = rawFuelType.trim().toUpperCase();
  if (!upper) return null;

  // Diesel — check first to avoid ambiguity
  if (upper === 'DIESEL' || (upper.includes('DIESEL') && !upper.includes('HYBRID'))) return 'diesel';

  // Hybrids — any hybrid burns 95-RON petrol at the pump.
  // Must be checked BEFORE the pure-electric check because "HYBRID ELECTRIC"
  // and "PETROL/ELECTRIC" should map to 'unleaded', not 'electric'.
  if (
    upper.includes('HYBRID') ||
    upper.includes('PHEV') ||
    upper.includes('PETROL/ELECTRIC') ||
    upper.includes('PETROL / ELECTRIC')
  ) {
    return 'unleaded';
  }

  // Pure electric
  if (
    upper === 'ELECTRICITY' ||
    upper === 'ELECTRIC' ||
    upper === 'EV' ||
    upper === 'BEV' ||
    upper.includes('ELECTRIC')
  ) {
    return 'electric';
  }

  // Petrol / gasoline
  if (upper.includes('PETROL') || upper.includes('GASOLINE')) return 'unleaded';

  return null;
}

/**
 * Given a raw DVLA fuelType string, return both derived normalised fields.
 *
 * @param {string|null|undefined} rawFuelType
 * @returns {{ fuel_type: string|null, fuel_category: 'diesel'|'unleaded'|'electric'|null }}
 */
function deriveFuelFields(rawFuelType) {
  const fuel_type = rawFuelType ? String(rawFuelType).toLowerCase() : null;
  const fuel_category = mapDvlaToFuelCategory(rawFuelType);
  return { fuel_type, fuel_category };
}

module.exports = { mapDvlaToFuelCategory, deriveFuelFields };

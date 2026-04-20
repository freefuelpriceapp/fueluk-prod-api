'use strict';

/**
 * stationQuarantine.js
 * Query-time deduplication and price sanity checks for station responses.
 *
 * Dedup: the same physical forecourt appears twice in the database — once
 * from the government feed and once from fuel_finder. We merge them at
 * response time by matching on postcode + approximate coordinates.
 *
 * Sanitize: prices below 110p or above 300p/L are clearly wrong and are
 * nullified before returning to the client. Ingest historically let a few
 * bad values through (e.g. Asda Swanley at 100p petrol).
 */

const COORD_TOLERANCE = 0.0005; // ~50m at UK latitudes
const MIN_PLAUSIBLE_PRICE = 110;
const MAX_PLAUSIBLE_PRICE = 300;
const DEFAULT_STALE_THRESHOLD_HOURS = 48;

const PRICE_FIELDS = [
  'petrol_price',
  'diesel_price',
  'e10_price',
  'super_unleaded_price',
  'premium_diesel_price',
];

const SOURCE_FIELDS = {
  petrol_price: 'petrol_source',
  diesel_price: 'diesel_source',
  e10_price: 'e10_source',
  super_unleaded_price: 'super_unleaded_source',
  premium_diesel_price: 'premium_diesel_source',
};

// Supermarket brand names (normalized via stripPunctuation+uppercase for matching).
const SUPERMARKET_BRAND_KEYS = new Set([
  'ASDA',
  'ASDAEXPRESS',
  'TESCO',
  'SAINSBURYS',
  'MORRISONS',
  'COSTCO',
  'COSTCOWHOLESALE',
]);

function normalizeBrandKey(brand) {
  if (brand == null) return '';
  return String(brand).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isSupermarketBrand(brand) {
  const key = normalizeBrandKey(brand);
  return key ? SUPERMARKET_BRAND_KEYS.has(key) : false;
}

function isFuelFinder(station) {
  return typeof station?.id === 'string' && station.id.startsWith('ff-');
}

function normalizePostcode(pc) {
  if (!pc) return '';
  return String(pc).replace(/\s+/g, '').toUpperCase();
}

function coordsMatch(a, b) {
  const aLat = Number(a.lat);
  const aLon = Number(a.lon);
  const bLat = Number(b.lat);
  const bLon = Number(b.lon);
  if (!Number.isFinite(aLat) || !Number.isFinite(aLon)) return false;
  if (!Number.isFinite(bLat) || !Number.isFinite(bLon)) return false;
  return Math.abs(aLat - bLat) <= COORD_TOLERANCE
    && Math.abs(aLon - bLon) <= COORD_TOLERANCE;
}

function pickFresher(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? 'a' : 'b';
  if (Number.isFinite(ta)) return 'a';
  if (Number.isFinite(tb)) return 'b';
  return 'a';
}

/**
 * Merge two station records that represent the same physical forecourt.
 * fuel_finder data wins for premium fuels, opening hours, and amenities.
 * For standard fuels we prefer fuel_finder when both sources have a price;
 * otherwise the more recently updated side wins.
 */
function mergeStations(primary, secondary) {
  const ffSide = isFuelFinder(primary) ? primary : (isFuelFinder(secondary) ? secondary : null);
  const govSide = ffSide === primary ? secondary : (ffSide === secondary ? primary : secondary);

  // If neither looks like fuel_finder, fall back to freshness-ordered merge.
  const base = ffSide || primary;
  const other = ffSide ? govSide : secondary;

  const merged = { ...other, ...base };

  // Re-resolve each price field with source attribution.
  for (const field of PRICE_FIELDS) {
    const sourceField = SOURCE_FIELDS[field];
    const baseVal = base[field];
    const otherVal = other[field];

    if (ffSide) {
      // fuel_finder wins for premium/exotic fuels it uniquely exposes.
      const ffOnly = field === 'super_unleaded_price' || field === 'premium_diesel_price';
      if (ffOnly) {
        if (ffSide[field] != null) {
          merged[field] = ffSide[field];
          merged[sourceField] = ffSide[sourceField] || 'fuel_finder';
        } else if (govSide && govSide[field] != null) {
          merged[field] = govSide[field];
          merged[sourceField] = govSide[sourceField] || 'gov';
        } else {
          merged[field] = null;
          merged[sourceField] = null;
        }
        continue;
      }
      // Standard fuels: prefer fuel_finder if it has a value, else fall back.
      if (ffSide[field] != null) {
        merged[field] = ffSide[field];
        merged[sourceField] = ffSide[sourceField] || 'fuel_finder';
      } else if (govSide && govSide[field] != null) {
        merged[field] = govSide[field];
        merged[sourceField] = govSide[sourceField] || 'gov';
      } else {
        merged[field] = null;
        merged[sourceField] = null;
      }
      continue;
    }

    // No fuel_finder side — pick the fresher-valued one.
    if (baseVal != null && otherVal != null) {
      const winner = pickFresher(base.last_updated, other.last_updated);
      merged[field] = winner === 'a' ? baseVal : otherVal;
      merged[sourceField] = winner === 'a'
        ? (base[sourceField] || null)
        : (other[sourceField] || null);
    } else if (baseVal != null) {
      merged[field] = baseVal;
      merged[sourceField] = base[sourceField] || null;
    } else if (otherVal != null) {
      merged[field] = otherVal;
      merged[sourceField] = other[sourceField] || null;
    } else {
      merged[field] = null;
      merged[sourceField] = null;
    }
  }

  // Opening hours & amenities — prefer fuel_finder (gov doesn't have them).
  if (ffSide) {
    merged.opening_hours = ffSide.opening_hours || (govSide && govSide.opening_hours) || null;
    const amenities = ffSide.amenities && ffSide.amenities.length
      ? ffSide.amenities
      : (govSide && govSide.amenities) || [];
    merged.amenities = amenities;
  }

  // Keep fuel_finder ID as primary when available.
  if (ffSide) merged.id = ffSide.id;

  // last_updated should reflect the newest known timestamp.
  const tBase = base.last_updated ? Date.parse(base.last_updated) : NaN;
  const tOther = other.last_updated ? Date.parse(other.last_updated) : NaN;
  if (Number.isFinite(tBase) && Number.isFinite(tOther)) {
    merged.last_updated = tBase >= tOther ? base.last_updated : other.last_updated;
  } else {
    merged.last_updated = base.last_updated || other.last_updated || null;
  }

  // Preserve the nearer distance for list endpoints.
  const dBase = base.distance_miles;
  const dOther = other.distance_miles;
  if (typeof dBase === 'number' && typeof dOther === 'number') {
    merged.distance_miles = Math.min(dBase, dOther);
  } else if (typeof dBase === 'number') {
    merged.distance_miles = dBase;
  } else if (typeof dOther === 'number') {
    merged.distance_miles = dOther;
  }

  return merged;
}

/**
 * Merge duplicate station records in a list. Two stations are considered the
 * same if their normalized postcode matches AND their lat/lon are within
 * COORD_TOLERANCE of each other.
 */
function deduplicateStations(stations) {
  if (!Array.isArray(stations) || stations.length < 2) {
    return Array.isArray(stations) ? stations.slice() : [];
  }

  const result = [];
  const byPostcode = new Map();

  for (const station of stations) {
    if (!station || typeof station !== 'object') {
      result.push(station);
      continue;
    }
    const pc = normalizePostcode(station.postcode);
    if (!pc) {
      result.push(station);
      continue;
    }
    const bucket = byPostcode.get(pc);
    if (!bucket) {
      byPostcode.set(pc, [{ station, index: result.length }]);
      result.push(station);
      continue;
    }

    let mergedInto = -1;
    for (const entry of bucket) {
      if (coordsMatch(entry.station, station)) {
        const merged = mergeStations(entry.station, station);
        result[entry.index] = merged;
        entry.station = merged;
        mergedInto = entry.index;
        break;
      }
    }
    if (mergedInto === -1) {
      bucket.push({ station, index: result.length });
      result.push(station);
    }
  }

  return result;
}

/**
 * Null out obviously wrong fuel prices (outside 110p–300p) on each station.
 * Logs every quarantined field so we can track which source produced the
 * bogus data. Mutates copies, not the input objects.
 */
function sanitizeStationPrices(stations, { logger = console } = {}) {
  if (!Array.isArray(stations)) return [];

  return stations.map((station) => {
    if (!station || typeof station !== 'object') return station;

    let changed = false;
    const next = { ...station };

    for (const field of PRICE_FIELDS) {
      const raw = station[field];
      if (raw == null) continue;
      const num = Number(raw);
      if (!Number.isFinite(num)) continue;
      if (num < MIN_PLAUSIBLE_PRICE || num > MAX_PLAUSIBLE_PRICE) {
        changed = true;
        next[field] = null;
        const sourceField = SOURCE_FIELDS[field];
        const source = station[sourceField] || 'unknown';
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            `[Quarantine] Dropped ${field}=${num} for station ${station.id} `
            + `(postcode=${station.postcode || 'n/a'}, source=${source})`,
          );
        }
      }
    }

    return changed ? next : station;
  });
}

/**
 * Detect and null out cross-fuel price inversions:
 *   - E5 (super_unleaded_price / petrol_price at UK gov feeds) must be >= E10.
 *     Here petrol_price is the E5/standard unleaded column — if it is less
 *     than e10_price, the E5 value is stale/wrong and gets dropped.
 *   - premium_diesel_price must be >= diesel_price; otherwise the premium
 *     value is stale and gets dropped.
 * Mutates copies only. Logs every inversion for monitoring.
 */
function validateCrossFuelPrices(stations, { logger = console } = {}) {
  if (!Array.isArray(stations)) return [];

  return stations.map((station) => {
    if (!station || typeof station !== 'object') return station;

    let changed = false;
    let next = station;

    const petrol = station.petrol_price != null ? Number(station.petrol_price) : null;
    const e10 = station.e10_price != null ? Number(station.e10_price) : null;
    if (Number.isFinite(petrol) && Number.isFinite(e10) && petrol < e10) {
      next = changed ? next : { ...station };
      next.petrol_price = null;
      changed = true;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          `[Quarantine] Cross-fuel inversion E5<E10: petrol_price=${petrol} `
          + `e10_price=${e10} station=${station.id} postcode=${station.postcode || 'n/a'}`,
        );
      }
    }

    const diesel = station.diesel_price != null ? Number(station.diesel_price) : null;
    const premiumDiesel = station.premium_diesel_price != null
      ? Number(station.premium_diesel_price) : null;
    if (Number.isFinite(diesel) && Number.isFinite(premiumDiesel) && premiumDiesel < diesel) {
      next = changed ? next : { ...station };
      next.premium_diesel_price = null;
      changed = true;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          `[Quarantine] Cross-fuel inversion premium<diesel: premium_diesel_price=${premiumDiesel} `
          + `diesel_price=${diesel} station=${station.id} postcode=${station.postcode || 'n/a'}`,
        );
      }
    }

    return changed ? next : station;
  });
}

/**
 * Annotate each station with derived brand/freshness flags:
 *   - is_supermarket: true if brand matches a known supermarket name
 *   - price_age_hours: hours since last_updated (rounded to 1 dp) or null
 *   - stale: true if price_age_hours > staleThresholdHours
 * Preserves any existing is_supermarket=true (e.g. from fuel_finder ingest).
 */
function annotateStations(stations, {
  staleThresholdHours = DEFAULT_STALE_THRESHOLD_HOURS,
  now = Date.now(),
} = {}) {
  if (!Array.isArray(stations)) return [];

  return stations.map((station) => {
    if (!station || typeof station !== 'object') return station;

    const next = { ...station };

    const supermarketFromBrand = isSupermarketBrand(station.brand);
    next.is_supermarket = Boolean(station.is_supermarket) || supermarketFromBrand;

    let priceAgeHours = null;
    if (station.last_updated) {
      const t = Date.parse(station.last_updated);
      if (Number.isFinite(t)) {
        priceAgeHours = Math.round(((now - t) / 3_600_000) * 10) / 10;
      }
    }
    next.price_age_hours = priceAgeHours;
    next.stale = priceAgeHours != null && priceAgeHours > staleThresholdHours;

    return next;
  });
}

module.exports = {
  deduplicateStations,
  sanitizeStationPrices,
  validateCrossFuelPrices,
  annotateStations,
  mergeStations,
  isSupermarketBrand,
  MIN_PLAUSIBLE_PRICE,
  MAX_PLAUSIBLE_PRICE,
  COORD_TOLERANCE,
  SUPERMARKET_BRAND_KEYS,
  DEFAULT_STALE_THRESHOLD_HOURS,
};

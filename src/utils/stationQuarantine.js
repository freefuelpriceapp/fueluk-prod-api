'use strict';

/**
 * stationQuarantine.js
 * Query-time deduplication and price sanity checks for station responses.
 *
 * Dedup: the same physical forecourt appears twice in the database — once
 * from the government feed and once from fuel_finder. We merge them at
 * response time by matching on postcode + approximate coordinates.
 *
 * Sanitize: prices outside per-field plausibility bands are clearly wrong
 * and are nullified before returning to the client. Per-field floors
 * reflect UK May-2026 market reality — a single 110p floor was too lenient
 * (it let EG Small Heath Highway PFS through at petrol_price=140 even though
 * E5 super never sells below ~150p).
 */

const COORD_TOLERANCE = 0.0005; // ~50m at UK latitudes
const MIN_PLAUSIBLE_PRICE_BY_FIELD = {
  petrol_price: 150,
  e10_price: 130,
  super_unleaded_price: 150,
  diesel_price: 140,
  premium_diesel_price: 150,
};
const MIN_PLAUSIBLE_PRICE_FALLBACK = 130;
// Backward-compat: prior code/tests imported a single MIN_PLAUSIBLE_PRICE.
const MIN_PLAUSIBLE_PRICE = MIN_PLAUSIBLE_PRICE_FALLBACK;
const MAX_PLAUSIBLE_PRICE = 300;
const DEFAULT_STALE_THRESHOLD_HOURS = 48;

// Per-field freshness quarantine threshold. Statutory Fuel Finder feeds must
// publish price changes within 30 minutes; CMA brand feeds are typically
// daily. 24h is a generous safety net that catches genuinely stuck values
// (the B10 0AE Apple Green super_unleaded reading was over a year old) while
// not false-flagging stations whose CMA feed simply ran on its normal cadence.
const PER_FIELD_QUARANTINE_HOURS = 24;

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

// Per-field freshness timestamp columns.
const UPDATED_AT_FIELDS = {
  petrol_price: 'petrol_updated_at',
  diesel_price: 'diesel_updated_at',
  e10_price: 'e10_updated_at',
  super_unleaded_price: 'super_unleaded_updated_at',
  premium_diesel_price: 'premium_diesel_updated_at',
};

// Companion quarantine flag exposed in the API response.
const QUARANTINED_FIELDS = {
  petrol_price: 'petrol_price_quarantined',
  diesel_price: 'diesel_price_quarantined',
  e10_price: 'e10_price_quarantined',
  super_unleaded_price: 'super_unleaded_price_quarantined',
  premium_diesel_price: 'premium_diesel_price_quarantined',
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
  // Source priority: Fuel Finder (gov) > brand-direct CMA feed > scraped.
  // We also propagate the per-field updated_at timestamp from the winning
  // side so quarantine decisions downstream evaluate the correct field age.
  for (const field of PRICE_FIELDS) {
    const sourceField = SOURCE_FIELDS[field];
    const tsField = UPDATED_AT_FIELDS[field];
    const baseVal = base[field];
    const otherVal = other[field];

    const assign = (winner, fallbackSource) => {
      merged[field] = winner ? winner[field] : null;
      merged[sourceField] = winner ? (winner[sourceField] || fallbackSource) : null;
      merged[tsField] = winner
        ? (winner[tsField] || winner.last_updated || null)
        : null;
    };

    if (ffSide) {
      // fuel_finder wins for premium/exotic fuels it uniquely exposes.
      const ffOnly = field === 'super_unleaded_price' || field === 'premium_diesel_price';
      if (ffOnly) {
        if (ffSide[field] != null) {
          assign(ffSide, 'fuel_finder');
        } else if (govSide && govSide[field] != null) {
          assign(govSide, 'gov');
        } else {
          assign(null);
        }
        continue;
      }
      // Standard fuels: prefer fuel_finder if it has a value, else fall back.
      if (ffSide[field] != null) {
        assign(ffSide, 'fuel_finder');
      } else if (govSide && govSide[field] != null) {
        assign(govSide, 'gov');
      } else {
        assign(null);
      }
      continue;
    }

    // No fuel_finder side — pick the fresher-valued one.
    if (baseVal != null && otherVal != null) {
      const winner = pickFresher(base.last_updated, other.last_updated);
      const winnerSide = winner === 'a' ? base : other;
      assign(winnerSide, winnerSide[sourceField] || null);
    } else if (baseVal != null) {
      assign(base, base[sourceField] || null);
    } else if (otherVal != null) {
      assign(other, other[sourceField] || null);
    } else {
      assign(null);
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
 * Null out obviously wrong fuel prices on each station, using per-field
 * minimum floors and a shared 300p ceiling. Quarantined values are
 * preserved on `<field>_quarantined_value` for audit; the live `<field>`
 * is set to null and `<field>_quarantined` / `<field>_quarantine_reason`
 * flags are emitted so the UI can explain why the price is missing.
 *
 * Station identity and location are never altered — per data policy we
 * only quarantine the bad field, never hide the station.
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
      const minFloor = MIN_PLAUSIBLE_PRICE_BY_FIELD[field] ?? MIN_PLAUSIBLE_PRICE_FALLBACK;
      if (num < minFloor || num > MAX_PLAUSIBLE_PRICE) {
        changed = true;
        next[field] = null;
        next[QUARANTINED_FIELDS[field]] = true;
        next[`${field}_quarantine_reason`] = 'implausible_value';
        next[`${field}_quarantined_value`] = num;
        const sourceField = SOURCE_FIELDS[field];
        const source = station[sourceField] || 'unknown';
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            `[Quarantine] Dropped ${field}=${num} for station ${station.id} `
            + `(postcode=${station.postcode || 'n/a'}, source=${source}, `
            + `floor=${minFloor})`,
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
 * Wave B.1b: Cross-field inversion validator.
 *
 * Several ASDA Express Petrol sites (B92, CV4, LS11, M8, NE4, SR4, G5)
 * publish super_unleaded_price 1–2p BELOW petrol_price. E5 super is a
 * premium grade — it cannot be cheaper than the standard E5 it's based
 * on, nor below E10. Likewise premium_diesel must be >= diesel.
 *
 * For each detected inversion we quarantine the offending field using
 * the same {field}_quarantine_reason / {field}_quarantined_value sibling
 * fields Wave A.1 introduced, with a `cross_field_inversion_*` reason so
 * the UI / metrics can distinguish from staleness or implausibility.
 *
 * Note: we DO already null E5 (petrol_price) when petrol < e10 in
 * validateCrossFuelPrices; this validator extends that to also stamp
 * the per-field quarantine sibling fields and to cover the new super<petrol,
 * super<e10, premium_diesel<diesel cases.
 *
 * Mutates copies only.
 */
function validateCrossFieldRelationships(stations, { logger = console } = {}) {
  if (!Array.isArray(stations)) return [];

  const RULES = [
    {
      field: 'super_unleaded_price',
      against: 'petrol_price',
      reason: 'cross_field_inversion_super_lt_petrol',
      cmp: (sub, ref) => sub < ref,
    },
    {
      field: 'super_unleaded_price',
      against: 'e10_price',
      reason: 'cross_field_inversion_super_lt_e10',
      cmp: (sub, ref) => sub < ref,
    },
    {
      field: 'petrol_price',
      against: 'e10_price',
      reason: 'cross_field_inversion_petrol_lt_e10',
      cmp: (sub, ref) => sub < ref,
    },
    {
      field: 'premium_diesel_price',
      against: 'diesel_price',
      reason: 'cross_field_inversion_premium_lt_standard',
      cmp: (sub, ref) => sub < ref,
    },
  ];

  return stations.map((station) => {
    if (!station || typeof station !== 'object') return station;

    let next = station;
    let changed = false;

    for (const rule of RULES) {
      const subVal = station[rule.field];
      const refVal = station[rule.against];
      if (subVal == null || refVal == null) continue;
      const subNum = Number(subVal);
      const refNum = Number(refVal);
      if (!Number.isFinite(subNum) || !Number.isFinite(refNum)) continue;
      // Skip a field that's already been quarantined upstream — don't double-stamp.
      if (next[QUARANTINED_FIELDS[rule.field]]) continue;
      if (!rule.cmp(subNum, refNum)) continue;

      if (!changed) { next = { ...station }; changed = true; }
      next[rule.field] = null;
      next[QUARANTINED_FIELDS[rule.field]] = true;
      next[`${rule.field}_quarantine_reason`] = rule.reason;
      next[`${rule.field}_quarantined_value`] = subNum;
      const sourceField = SOURCE_FIELDS[rule.field];
      const source = station[sourceField] || 'unknown';
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          `[Quarantine] Cross-field inversion ${rule.field}=${subNum} `
          + `< ${rule.against}=${refNum} for station ${station.id} `
          + `(postcode=${station.postcode || 'n/a'}, source=${source}, reason=${rule.reason})`,
        );
      }
    }

    return next;
  });
}

/**
 * Per-field freshness quarantine.
 *
 * For each price field, if the per-field timestamp is older than
 * `quarantineHours` (default 24), set:
 *   - `<field>_quarantined: true`
 *   - `<field>_quarantine_reason: 'stale_over_<n>h'`
 *   - move the original price to `<field>_quarantined_value` so the UI
 *     can still show it greyed-out as "data may be outdated"
 *   - null the live `<field>` so price-comparison logic ignores it
 *
 * If the per-field timestamp is missing but the price isn't, we fall back
 * to the station-wide `last_updated`. A null/missing timestamp on a
 * non-null price is treated as quarantined-by-unknown-age — better safe
 * than serving a stuck reading.
 *
 * The CRITICAL POLICY in `data_handling.md` is preserved here: we never
 * drop the station; we only flag the bad field.
 */
function quarantineStaleFields(stations, {
  quarantineHours = PER_FIELD_QUARANTINE_HOURS,
  now = Date.now(),
  logger = null,
} = {}) {
  if (!Array.isArray(stations)) return [];
  const cutoff = now - quarantineHours * 3_600_000;

  return stations.map((station) => {
    if (!station || typeof station !== 'object') return station;
    const next = { ...station };

    for (const priceField of PRICE_FIELDS) {
      const flagField = QUARANTINED_FIELDS[priceField];
      if (!flagField) continue;

      const price = station[priceField];
      if (price == null) {
        next[flagField] = false;
        continue;
      }

      const tsField = UPDATED_AT_FIELDS[priceField];
      const tsRaw = station[tsField] || station.last_updated || null;
      const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
      const isStale = !Number.isFinite(tsMs) || tsMs < cutoff;
      if (!isStale) {
        next[flagField] = false;
        continue;
      }

      next[flagField] = true;
      next[`${priceField}_quarantine_reason`] = Number.isFinite(tsMs)
        ? `stale_over_${quarantineHours}h`
        : 'no_timestamp';
      next[`${priceField}_quarantined_value`] = price;
      next[priceField] = null;
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          `[Quarantine] Stale ${priceField}=${price} for station ${station.id} `
          + `(age=${Number.isFinite(tsMs) ? Math.round((now - tsMs) / 3_600_000) + 'h' : 'unknown'}, `
          + `source=${station[SOURCE_FIELDS[priceField]] || 'unknown'})`,
        );
      }
    }

    return next;
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

const FUEL_PRICE_FIELDS = {
  petrol: 'petrol_price',
  diesel: 'diesel_price',
  e10: 'e10_price',
  super_unleaded: 'super_unleaded_price',
  premium_diesel: 'premium_diesel_price',
};

/**
 * Pick the index of the "best option" for the selected fuel from a list of
 * stations, using the rule: cheapest fresh price wins, tie-broken by distance.
 * Returns { index, reason } or null when no candidate has a usable price.
 * Fresh = has a non-null price AND is not flagged stale.
 */
function selectBestOptionIndex(stations, fuelType = 'petrol', { radiusMiles } = {}) {
  if (!Array.isArray(stations) || !stations.length) return null;
  const priceField = FUEL_PRICE_FIELDS[fuelType] || FUEL_PRICE_FIELDS.petrol;

  let bestIdx = -1;
  let bestPrice = Infinity;
  let bestDistance = Infinity;
  for (let i = 0; i < stations.length; i += 1) {
    const s = stations[i];
    if (!s || typeof s !== 'object') continue;
    const price = s[priceField];
    if (price == null) continue;
    const numeric = Number(price);
    if (!Number.isFinite(numeric)) continue;
    if (s.stale) continue;
    const dist = typeof s.distance_miles === 'number' ? s.distance_miles : Infinity;
    if (numeric < bestPrice || (numeric === bestPrice && dist < bestDistance)) {
      bestIdx = i;
      bestPrice = numeric;
      bestDistance = dist;
    }
  }

  if (bestIdx === -1) return null;
  const radiusLabel = Number.isFinite(Number(radiusMiles)) ? ` within ${Number(radiusMiles)} mi` : '';
  const fuelLabel = fuelType === 'super_unleaded' ? 'super unleaded'
    : fuelType === 'premium_diesel' ? 'premium diesel'
    : fuelType;
  return { index: bestIdx, reason: `Cheapest ${fuelLabel}${radiusLabel}` };
}

module.exports = {
  deduplicateStations,
  sanitizeStationPrices,
  validateCrossFuelPrices,
  validateCrossFieldRelationships,
  annotateStations,
  mergeStations,
  isSupermarketBrand,
  selectBestOptionIndex,
  quarantineStaleFields,
  MIN_PLAUSIBLE_PRICE,
  MIN_PLAUSIBLE_PRICE_BY_FIELD,
  MIN_PLAUSIBLE_PRICE_FALLBACK,
  MAX_PLAUSIBLE_PRICE,
  COORD_TOLERANCE,
  SUPERMARKET_BRAND_KEYS,
  DEFAULT_STALE_THRESHOLD_HOURS,
  PER_FIELD_QUARANTINE_HOURS,
  FUEL_PRICE_FIELDS,
  PRICE_FIELDS,
  SOURCE_FIELDS,
  UPDATED_AT_FIELDS,
  QUARANTINED_FIELDS,
};

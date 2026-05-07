'use strict';

/**
 * cmaFailoverService.js — Wave B.1a
 *
 * Statutory CMA brand feeds (govFuelData.js) are normally a SECONDARY
 * source: Fuel Finder wins. But when a Fuel Finder reading goes stale
 * (>24h) and gets quarantined by Wave A.1, we still serve null even
 * though the brand's CMA feed may be fresh. Audit week showed 75% of
 * "anomalies" were stations correctly quarantined while their CMA feed
 * had a fresh price — a recoverable blackout.
 *
 * This service maintains a brand-feed snapshot in memory, keyed by
 * (canonical brand + lat/lon bucket), and exposes a query-time helper
 * that injects a fresh CMA price into a station whose Fuel Finder field
 * is quarantined-stale.
 *
 * Refresh: every 6h via scheduleCmaSnapshotRefresh() (or piggy-backs on
 * the existing 2h govFuelData.scheduleFuelSync — both write into the
 * same in-memory cache via recordSnapshot()).
 *
 * Feature flag: FEATURE_CMA_FAILOVER (off by default — preserves Wave
 * A.1 behaviour until ops flip the flag in the task def).
 */

const axios = require('axios');
const cron = require('node-cron');
const { canonicalBrandName } = require('../utils/brandNormalizer');

const FAILOVER_FLAG_ENV = 'FEATURE_CMA_FAILOVER';
const COORD_BUCKET = 1000; // ~110m at UK latitudes — same target as the
                           // 50m brief, slightly looser to absorb feed drift.
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // entries older than 24h are
                                             // considered just as stale as
                                             // the Fuel Finder side they
                                             // would replace.
const REFRESH_CRON = '0 */6 * * *';

// brand JSON URLs mirror govFuelData.js — keep them in sync if either changes.
const BRAND_FEEDS = [
  { name: 'Applegreen', url: 'https://applegreenstores.com/fuel-prices/data.json' },
  { name: 'Ascona', url: 'https://fuelprices.asconagroup.co.uk/newfuel.json' },
  { name: 'Asda', url: 'https://storelocator.asda.com/fuel_prices_data.json' },
  { name: 'BP', url: 'https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json' },
  { name: 'Esso', url: 'https://fuelprices.esso.co.uk/latestdata.json' },
  { name: 'JET', url: 'https://jetlocal.co.uk/fuel_prices_data.json' },
  { name: 'Morrisons', url: 'https://www.morrisons.com/fuel-prices/fuel.json' },
  { name: 'Moto', url: 'https://www.moto-way.com/fuel-price/fuel_prices.json' },
  { name: 'Motor Fuel Group', url: 'https://fuel.motorfuelgroup.com/fuel_prices_data.json' },
  { name: 'Rontec', url: 'https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json' },
  { name: 'Sainsburys', url: 'https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json' },
  { name: 'SGN', url: 'https://www.sgnretail.uk/files/data/SGN_daily_fuel_prices.json' },
  { name: 'Tesco', url: 'https://www.tesco.com/fuel_prices/fuel_prices_data.json' },
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// In-memory snapshot. Map<key, { brand, lat, lon, prices, fetchedAt }>
const snapshot = new Map();

function isFlagEnabled() {
  return String(process.env[FAILOVER_FLAG_ENV] || '').toLowerCase() === 'true';
}

function bucketCoord(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * COORD_BUCKET) / COORD_BUCKET;
}

function brandKey(brand) {
  if (!brand) return '';
  return canonicalBrandName(String(brand)).toUpperCase();
}

function buildKey(brand, lat, lon) {
  const lb = bucketCoord(lat);
  const ob = bucketCoord(lon);
  if (lb == null || ob == null) return null;
  return `${brandKey(brand)}|${lb}|${ob}`;
}

function clearSnapshot() { snapshot.clear(); }

function recordSnapshot(entry) {
  if (!entry || !entry.brand) return;
  const key = buildKey(entry.brand, entry.lat, entry.lon);
  if (!key) return;
  snapshot.set(key, {
    brand: entry.brand,
    lat: Number(entry.lat),
    lon: Number(entry.lon),
    prices: { ...entry.prices },
    fetchedAt: entry.fetchedAt || Date.now(),
  });
}

function snapshotSize() { return snapshot.size; }

function sanitisePrice(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 50 || num > 400) return null;
  return Math.round(num * 10) / 10;
}

async function fetchBrand(feed) {
  try {
    const resp = await axios.get(feed.url, {
      timeout: 10000,
      headers: { 'User-Agent': USER_AGENT },
    });
    return Array.isArray(resp.data?.stations) ? resp.data.stations : [];
  } catch (err) {
    return [];
  }
}

async function refreshSnapshot({ now = Date.now(), feeds = BRAND_FEEDS } = {}) {
  let recorded = 0;
  for (const feed of feeds) {
    const stations = await fetchBrand(feed);
    for (const st of stations) {
      const lat = parseFloat(st.location?.latitude || st.lat || 0);
      const lon = parseFloat(st.location?.longitude || st.lng || 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      const prices = {
        petrol_price: sanitisePrice(st.prices?.E5),
        diesel_price: sanitisePrice(st.prices?.B7),
        e10_price: sanitisePrice(st.prices?.E10),
      };
      if (prices.petrol_price == null && prices.diesel_price == null && prices.e10_price == null) continue;
      recordSnapshot({ brand: feed.name, lat, lon, prices, fetchedAt: now });
      recorded += 1;
    }
  }
  return { recorded, size: snapshotSize() };
}

function scheduleCmaSnapshotRefresh({ runOnBoot = false } = {}) {
  if (runOnBoot) refreshSnapshot().catch(() => { /* swallow — best effort */ });
  cron.schedule(REFRESH_CRON, () => {
    refreshSnapshot().catch(() => { /* swallow */ });
  });
}

const QUARANTINE_REASONS_ELIGIBLE_FOR_FAILOVER = new Set([
  'stale_over_24h',
  'no_timestamp',
]);

const FAILOVERABLE_FIELDS = ['petrol_price', 'diesel_price', 'e10_price'];

const SOURCE_FIELDS = {
  petrol_price: 'petrol_source',
  diesel_price: 'diesel_source',
  e10_price: 'e10_source',
};

const QUARANTINE_FLAG_FIELDS = {
  petrol_price: 'petrol_price_quarantined',
  diesel_price: 'diesel_price_quarantined',
  e10_price: 'e10_price_quarantined',
};

const UPDATED_AT_FIELDS = {
  petrol_price: 'petrol_updated_at',
  diesel_price: 'diesel_updated_at',
  e10_price: 'e10_updated_at',
};

/**
 * Look up the CMA snapshot entry for a station. Returns the entry if found
 * AND the entry is fresher than the quarantine cutoff; null otherwise.
 *
 * The brand match must be canonical: Esso ≠ Esso Express ≠ Shell. The lat/lon
 * bucket must match exactly (≈110m at UK latitudes). A cross-brand entry
 * never wins — we never inject Esso prices into a Shell station's response.
 */
function lookupSnapshot(station, { now = Date.now() } = {}) {
  if (!station || !station.brand) return null;
  const key = buildKey(station.brand, station.lat ?? station.latitude, station.lon ?? station.longitude);
  if (!key) return null;
  const entry = snapshot.get(key);
  if (!entry) return null;
  if (now - entry.fetchedAt > SNAPSHOT_TTL_MS) return null;
  return entry;
}

/**
 * Per-station failover: for each price field that's currently null AND
 * was quarantined as stale (or had no timestamp), try to inject the CMA
 * snapshot value. Marks `source_used` on the station so we can observe
 * failover in the wild.
 *
 * Mutates copies only. Returns a new array even if nothing changed.
 */
function applyCmaFailover(stations, { now = Date.now() } = {}) {
  if (!Array.isArray(stations)) return [];
  if (!isFlagEnabled()) {
    return stations.map((s) => {
      if (!s || typeof s !== 'object') return s;
      if (s.source_used) return s;
      return { ...s, source_used: 'fuel_finder' };
    });
  }

  return stations.map((station) => {
    if (!station || typeof station !== 'object') return station;
    const next = { ...station };
    let anyFailedOver = false;
    let anyFresh = false;

    let snapshotEntry = null;
    for (const field of FAILOVERABLE_FIELDS) {
      const reason = station[`${field}_quarantine_reason`];
      const flag = station[QUARANTINE_FLAG_FIELDS[field]];
      const isQuarantined = flag === true && QUARANTINE_REASONS_ELIGIBLE_FOR_FAILOVER.has(reason);
      const livePrice = station[field];

      if (livePrice != null && !isQuarantined) {
        anyFresh = true;
        continue;
      }
      if (!isQuarantined) continue;

      if (snapshotEntry === null) {
        snapshotEntry = lookupSnapshot(station, { now }) || false;
      }
      if (!snapshotEntry) continue;

      const cmaPrice = snapshotEntry.prices[field];
      if (cmaPrice == null) continue;

      next[field] = cmaPrice;
      next[QUARANTINE_FLAG_FIELDS[field]] = false;
      next[`${field}_quarantine_reason`] = null;
      next[SOURCE_FIELDS[field]] = 'cma';
      next[UPDATED_AT_FIELDS[field]] = new Date(snapshotEntry.fetchedAt).toISOString();
      anyFailedOver = true;
    }

    if (anyFailedOver && anyFresh) next.source_used = 'mixed';
    else if (anyFailedOver) next.source_used = 'cma';
    else next.source_used = station.source_used || 'fuel_finder';

    return next;
  });
}

module.exports = {
  applyCmaFailover,
  refreshSnapshot,
  scheduleCmaSnapshotRefresh,
  recordSnapshot,
  clearSnapshot,
  snapshotSize,
  isFlagEnabled,
  buildKey,
  bucketCoord,
  brandKey,
  SNAPSHOT_TTL_MS,
  COORD_BUCKET,
  REFRESH_CRON,
  FAILOVER_FLAG_ENV,
  QUARANTINE_REASONS_ELIGIBLE_FOR_FAILOVER,
};

'use strict';

/**
 * Maps Fuel Finder API shapes to the columns used by `stations`.
 *
 * Fuel Finder fuel codes:
 *   E10          -> e10_price            (unleaded petrol, standard)
 *   E5           -> super_unleaded_price (RON95/98 premium unleaded)
 *   B7_STANDARD  -> diesel_price
 *   B7_PREMIUM   -> premium_diesel_price
 *
 * Prices on the Fuel Finder API arrive in pence (e.g. 129.9). This matches
 * the decimal format the DB already stores (DECIMAL(5,1)), so no unit
 * conversion is needed here — unlike the CMA feed which gives pence*10.
 */

const FUEL_TYPE_TO_PRICE_COLUMN = {
  E10: 'e10_price',
  E5: 'super_unleaded_price',
  B7_STANDARD: 'diesel_price',
  B7_PREMIUM: 'premium_diesel_price',
};

const FUEL_TYPE_TO_SOURCE_COLUMN = {
  E10: 'e10_source',
  E5: 'super_unleaded_source',
  B7_STANDARD: 'diesel_source',
  B7_PREMIUM: 'premium_diesel_source',
};

const SOURCE_TAG = 'fuel_finder';

function priceColumnForFuelType(code) {
  return FUEL_TYPE_TO_PRICE_COLUMN[code] || null;
}

function sourceColumnForFuelType(code) {
  return FUEL_TYPE_TO_SOURCE_COLUMN[code] || null;
}

function sanitisePrice(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  // Fuel Finder publishes in pence; reject absurd values to avoid poisoning
  // the UI if the feed misbehaves. Realistic UK pump range ~90p–250p.
  if (num < 50 || num > 400) return null;
  return Math.round(num * 10) / 10;
}

/**
 * Convert a Fuel Finder station payload into a flat row for upsert.
 * Returns null if the payload is missing required identifiers.
 */
function stationToRow(station) {
  if (!station || !station.node_id) return null;
  const loc = station.location || {};
  const id = `ff-${station.node_id}`;
  const brand = station.brand_name || station.trading_name || 'Unknown';
  const name = station.trading_name || station.brand_name || 'Unknown station';
  const addressParts = [
    station.address_line_1,
    station.address_line_2,
    station.locality,
    station.town,
  ].filter(Boolean);
  const address = addressParts.length ? addressParts.join(', ') : (loc.address || '');

  return {
    id,
    fuel_finder_node_id: station.node_id,
    brand,
    name,
    address,
    postcode: loc.postcode || station.postcode || '',
    lat: toNumber(loc.latitude),
    lng: toNumber(loc.longitude),
    is_motorway: !!station.is_motorway_service_station,
    is_supermarket: !!station.is_supermarket_service_station,
    temporary_closure: !!station.temporary_closure,
    permanent_closure: !!station.permanent_closure,
    opening_hours: station.opening_times || null,
    amenities: station.amenities || null,
    fuel_types: station.fuel_types || null,
  };
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert a Fuel Finder price payload into an array of
 * { priceColumn, sourceColumn, price, updatedAt } entries.
 * Silently drops unknown fuel types so a new code the API adds
 * later does not break the whole batch.
 */
function pricesToColumnUpdates(priceRecord) {
  if (!priceRecord || !Array.isArray(priceRecord.fuel_prices)) return [];
  const out = [];
  for (const fp of priceRecord.fuel_prices) {
    const col = priceColumnForFuelType(fp.fuel_type);
    const srcCol = sourceColumnForFuelType(fp.fuel_type);
    const price = sanitisePrice(fp.price);
    if (!col || !srcCol || price === null) continue;
    out.push({
      priceColumn: col,
      sourceColumn: srcCol,
      price,
      updatedAt: fp.price_last_updated || null,
    });
  }
  return out;
}

module.exports = {
  FUEL_TYPE_TO_PRICE_COLUMN,
  FUEL_TYPE_TO_SOURCE_COLUMN,
  SOURCE_TAG,
  priceColumnForFuelType,
  sourceColumnForFuelType,
  sanitisePrice,
  stationToRow,
  pricesToColumnUpdates,
};

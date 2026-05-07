'use strict';
const axios = require('axios');
const cron = require('node-cron');
const { getPool } = require('../config/db');

// UK Gov fuel price data sources (CMA Open Data scheme)
// E5 = Premium Petrol (95 RON) -> petrol_price
// B7 = Diesel -> diesel_price
// E10 = Standard Petrol (E10) -> e10_price
//
// Note: Some brand URLs block requests without a browser-like User-Agent (BP, Tesco).
// Shell serves HTML not JSON — excluded. Co-op DNS defunct — excluded.

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Full browser headers for brands that enforce strict bot-detection (e.g. Tesco, BP)
const BROWSER_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

// Brands that require full browser headers to avoid 403 errors
const STRICT_BRANDS = ['Tesco', 'BP'];

const BRANDS = [
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

async function fetchBrand(brand) {
  try {
    const headers = STRICT_BRANDS.includes(brand.name)
      ? { ...BROWSER_HEADERS, 'Referer': new URL(brand.url).origin + '/' }
      : { 'User-Agent': USER_AGENT };

    const resp = await axios.get(brand.url, {
      timeout: 10000,
      headers,
    });
    return { brand: brand.name, stations: resp.data.stations || [] };
  } catch (err) {
    console.warn(`Failed to fetch ${brand.name}:`, err.message);
    return { brand: brand.name, stations: [] };
  }
}

// Realistic UK pump-price range in pence/litre. Brand feeds publish prices
// directly in pence (e.g. Asda E10 = 152.9), so we validate rather than scale.
function sanitisePrice(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 50 || num > 400) return null;
  return Math.round(num * 10) / 10;
}

async function syncFuelData() {
  console.log('Starting Gov UK fuel data sync...');
  const pool = getPool();
  let totalUpserted = 0;
  const errors = [];

  for (const brand of BRANDS) {
    const data = await fetchBrand(brand);
    for (const station of data.stations) {
      try {
        // UK Gov Open Data price codes (all values in pence/litre):
        // E5  = Premium Petrol (RON95 E5)  -> stored as petrol_price
        // B7  = Diesel (B7)                -> stored as diesel_price
        // E10 = Standard Petrol (E10)      -> stored as e10_price
        const petrolPrice = sanitisePrice(station.prices?.E5);
        const dieselPrice = sanitisePrice(station.prices?.B7);
        const e10Price    = sanitisePrice(station.prices?.E10);

        // CMA brand feeds are SECONDARY to Fuel Finder. Only overwrite a
        // price field if the current source is NOT 'fuel_finder' — i.e.
        // gov-statutory data always wins. We also stamp a per-field
        // timestamp whenever we actually wrote a value, so the response
        // builder can quarantine fields that haven't been refreshed in 24h.
        await pool.query(
          `INSERT INTO stations (id, brand, name, address, postcode, lat, lng,
                        petrol_price, diesel_price, e10_price,
                        petrol_source, diesel_source, e10_source,
                        petrol_updated_at, diesel_updated_at, e10_updated_at,
                        last_updated)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                              CASE WHEN $8::numeric  IS NOT NULL THEN NOW() ELSE NULL END,
                              CASE WHEN $9::numeric  IS NOT NULL THEN NOW() ELSE NULL END,
                              CASE WHEN $10::numeric IS NOT NULL THEN NOW() ELSE NULL END,
                              NOW())
           ON CONFLICT (id) DO UPDATE SET
                        petrol_price = CASE
                          WHEN stations.petrol_source = 'fuel_finder' THEN stations.petrol_price
                          WHEN EXCLUDED.petrol_price IS NOT NULL THEN EXCLUDED.petrol_price
                          ELSE stations.petrol_price END,
                        diesel_price = CASE
                          WHEN stations.diesel_source = 'fuel_finder' THEN stations.diesel_price
                          WHEN EXCLUDED.diesel_price IS NOT NULL THEN EXCLUDED.diesel_price
                          ELSE stations.diesel_price END,
                        e10_price = CASE
                          WHEN stations.e10_source = 'fuel_finder' THEN stations.e10_price
                          WHEN EXCLUDED.e10_price IS NOT NULL THEN EXCLUDED.e10_price
                          ELSE stations.e10_price END,
                        petrol_source = CASE
                          WHEN stations.petrol_source = 'fuel_finder' THEN stations.petrol_source
                          WHEN EXCLUDED.petrol_price IS NOT NULL THEN 'gov'
                          ELSE stations.petrol_source END,
                        diesel_source = CASE
                          WHEN stations.diesel_source = 'fuel_finder' THEN stations.diesel_source
                          WHEN EXCLUDED.diesel_price IS NOT NULL THEN 'gov'
                          ELSE stations.diesel_source END,
                        e10_source = CASE
                          WHEN stations.e10_source = 'fuel_finder' THEN stations.e10_source
                          WHEN EXCLUDED.e10_price IS NOT NULL THEN 'gov'
                          ELSE stations.e10_source END,
                        petrol_updated_at = CASE
                          WHEN stations.petrol_source = 'fuel_finder' THEN stations.petrol_updated_at
                          WHEN EXCLUDED.petrol_price IS NOT NULL THEN NOW()
                          ELSE stations.petrol_updated_at END,
                        diesel_updated_at = CASE
                          WHEN stations.diesel_source = 'fuel_finder' THEN stations.diesel_updated_at
                          WHEN EXCLUDED.diesel_price IS NOT NULL THEN NOW()
                          ELSE stations.diesel_updated_at END,
                        e10_updated_at = CASE
                          WHEN stations.e10_source = 'fuel_finder' THEN stations.e10_updated_at
                          WHEN EXCLUDED.e10_price IS NOT NULL THEN NOW()
                          ELSE stations.e10_updated_at END,
            last_updated = NOW()`,
          [
            station.site_id || station.id,
            data.brand,
            station.brand || data.brand,
            station.address || '',
            station.postcode || '',
            parseFloat(station.location?.latitude  || station.lat || 0),
            parseFloat(station.location?.longitude || station.lng || 0),
            petrolPrice,
            dieselPrice,
            e10Price,
                        petrolPrice ? 'gov' : null,
            dieselPrice ? 'gov' : null,
            e10Price ? 'gov' : null
          ]
        );
        totalUpserted++;
      } catch (e) {
        errors.push({ brand: data.brand, message: e.message });
      }
    }
  }
  console.log(`Fuel sync complete: ${totalUpserted} stations upserted`);
  return { totalUpserted, errors };
}

function scheduleFuelSync() {
  syncFuelData().catch(console.error);
  cron.schedule('0 */2 * * *', () => {
    syncFuelData().catch(console.error);
  });
  console.log('Fuel sync scheduled every 2 hours');
}

module.exports = { scheduleFuelSync, syncFuelData };

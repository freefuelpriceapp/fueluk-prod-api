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

async function syncFuelData() {
  console.log('Starting Gov UK fuel data sync...');
  const pool = getPool();
  let totalUpserted = 0;
  const errors = [];

  for (const brand of BRANDS) {
    const data = await fetchBrand(brand);
    for (const station of data.stations) {
      try {
        // UK Gov Open Data price codes:
        // E5  = Premium Petrol (RON95 E5)  -> stored as petrol_price
        // B7  = Diesel (B7)                -> stored as diesel_price
        // E10 = Standard Petrol (E10)      -> stored as e10_price
        const petrolPrice = station.prices?.E5  ? station.prices.E5  / 10 : null;
        const dieselPrice = station.prices?.B7  ? station.prices.B7  / 10 : null;
        const e10Price    = station.prices?.E10 ? station.prices.E10 / 10 : null;

        await pool.query(
          `INSERT INTO stations (id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, last_updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
           ON CONFLICT (id) DO UPDATE SET
                        petrol_price = COALESCE(EXCLUDED.petrol_price, stations.petrol_price),
                        diesel_price = COALESCE(EXCLUDED.diesel_price, stations.diesel_price),
                        e10_price = COALESCE(EXCLUDED.e10_price, stations.e10_price),
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
            e10Price
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

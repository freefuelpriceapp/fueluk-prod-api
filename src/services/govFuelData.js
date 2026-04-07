'use strict';
const axios = require('axios');
const cron = require('node-cron');
const { getPool } = require('../config/db');

const GOV_FUEL_URL = 'https://www.gov.uk/guidance/access-fuel-price-data';
const BRANDS = [
  { name: 'Applegreen', url: 'https://applegreenstores.com/fuel-prices/data.json' },
  { name: 'Ascona', url: 'https://fuelprices.asconagroup.co.uk/newfuel.json' },
  { name: 'Asda', url: 'https://storelocator.asda.com/fuel_prices_data.json' },
  { name: 'BP', url: 'https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json' },
  { name: 'Co-op', url: 'https://fuel.coop.co.uk/fuel_prices_data.json' },
  { name: 'Esso', url: 'https://fuelprices.esso.co.uk/fuel_prices_data.json' },
  { name: 'JET', url: 'https://jetlocal.co.uk/fuel_prices_data.json' },
  { name: 'Morrisons', url: 'https://www.morrisons.com/fuel-prices/fuel.json' },
  { name: 'Moto', url: 'https://www.moto-way.com/fuel-price/fuel_prices_data.json' },
  { name: 'Motor Fuel Group', url: 'https://fuel.motorfuelgroup.com/fuel_prices_data.json' },
  { name: 'Rontec', url: 'https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json' },
  { name: 'Sainsburys', url: 'https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json' },
  { name: 'SGN', url: 'https://www.sgnretail.uk/files/data/SGN_daily_fuel_prices.json' },
  { name: 'Shell', url: 'https://www.shell.co.uk/motorist/oils-and-lubricants/shell-fuels-locator/_jcr_content/root/main/section/simple_list/list_par/content_box/links.multi.fuel_prices_data.json' },
  { name: 'Tesco', url: 'https://www.tesco.com/fuel_prices/fuel_prices_data.json' },
];

async function fetchBrand(brand) {
  try {
    const resp = await axios.get(brand.url, { timeout: 10000 });
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

  for (const brand of BRANDS) {
    const data = await fetchBrand(brand);
    for (const station of data.stations) {
      try {
        await pool.query(
          `INSERT INTO stations (id, brand, name, address, postcode, lat, lng,
            petrol_price, diesel_price, e10_price, last_updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
           ON CONFLICT (id) DO UPDATE SET
            petrol_price = EXCLUDED.petrol_price,
            diesel_price = EXCLUDED.diesel_price,
            e10_price = EXCLUDED.e10_price,
            last_updated = NOW()`,
          [
            station.site_id || station.id,
            data.brand,
            station.brand || data.brand,
            station.address || '',
            station.postcode || '',
            parseFloat(station.location?.latitude || station.lat || 0),
            parseFloat(station.location?.longitude || station.lng || 0),
            station.prices?.E10 ? station.prices.E10 / 10 : null,
            station.prices?.B7 ? station.prices.B7 / 10 : null,
            station.prices?.E5 ? station.prices.E5 / 10 : null
          ]
        );
        totalUpserted++;
      } catch (e) {
        // skip bad records
      }
    }
  }
  console.log(`Fuel sync complete: ${totalUpserted} stations upserted`);
}

function scheduleFuelSync() {
  syncFuelData().catch(console.error);
  cron.schedule('0 */2 * * *', () => {
    syncFuelData().catch(console.error);
  });
  console.log('Fuel sync scheduled every 2 hours');
}

module.exports = { scheduleFuelSync, syncFuelData };

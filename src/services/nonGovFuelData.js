'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const { getPool } = require('../config/db');

/**
 * nonGovFuelData.js
 * Supplements missing gov-source prices with data from non-gov sources:
 * - Applegreen official pricing page (HTML scrape)
 * - PetrolMap.co.uk (HTML scrape)
 * - FindCheapFuel.com (HTML scrape)
 *
 * Only fills NULL prices in the stations table. Never overwrites valid gov data.
 * Stores source attribution in non_gov_prices table for transparency.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- Applegreen official site scraper ---
async function scrapeApplegreen() {
  const prices = [];
  try {
    const resp = await axios.get('https://applegreenstores.com/uk-fuel-pricing/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    const $ = cheerio.load(resp.data);
    $('table tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 5) {
        const address = $(cells[1]).text().trim();
        const postcode = $(cells[2]).text().trim();
        const unleaded = parsePrice($(cells[3]).text());
        const diesel = parsePrice($(cells[4]).text());
        if (postcode) {
          prices.push({ address, postcode, unleaded, diesel, source: 'applegreen_official' });
        }
      }
    });
  } catch (err) {
    console.warn('[NonGov] Applegreen scrape failed:', err.message);
  }
  return prices;
}

// --- PetrolMap scraper ---
async function scrapePetrolMap(postcode) {
  const prices = [];
  try {
    const resp = await axios.get(`https://petrolmap.co.uk/petrol-prices/search/${postcode}`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    const $ = cheerio.load(resp.data);
    $('.station-card').each((_, card) => {
      const name = $(card).find('.station-name').text().trim();
      const addr = $(card).find('.station-address').text().trim();
      const e10 = parsePrice($(card).find('.e10-price').text());
      const diesel = parsePrice($(card).find('.diesel-price').text());
      if (name) {
        prices.push({ name, address: addr, e10, diesel, source: 'petrolmap' });
      }
    });
  } catch (err) {
    console.warn('[NonGov] PetrolMap scrape failed:', err.message);
  }
  return prices;
}

function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.]/g, '');
  const val = parseFloat(cleaned);
  if (isNaN(val) || val < 100 || val > 250) return null; // pence sanity check
  return val / 10; // convert pence to same format as gov data (e.g., 152.7p -> 15.27)
}

/**
 * Fill missing prices for stations that have NULL values in the gov data.
 * Only updates where the gov source has a NULL and we have a non-gov value.
 */
async function fillMissingPrices() {
  const pool = getPool();
  console.log('[NonGov] Starting non-gov price fill...');
  let filled = 0;

  // Get stations with missing prices
  const { rows: missing } = await pool.query(`
    SELECT id, brand, name, address, postcode,
           petrol_price, diesel_price, e10_price
    FROM stations
    WHERE petrol_price IS NULL
       OR diesel_price IS NULL
       OR e10_price IS NULL
  `);

  if (missing.length === 0) {
    console.log('[NonGov] No missing prices found.');
    return { filled: 0 };
  }

  console.log(`[NonGov] Found ${missing.length} stations with missing prices.`);

  // Scrape Applegreen official site
  const agPrices = await scrapeApplegreen();

  for (const station of missing) {
    const updates = {};
    let source = null;

    // Try Applegreen match by postcode
    if (station.brand === 'Applegreen') {
      const match = agPrices.find(p =>
        p.postcode.replace(/\s/g, '').toUpperCase() ===
        (station.postcode || '').replace(/\s/g, '').toUpperCase()
      );
      if (match) {
        if (!station.petrol_price && match.unleaded) {
          updates.petrol_price = match.unleaded;
          source = 'applegreen_official';
        }
        if (!station.diesel_price && match.diesel) {
          updates.diesel_price = match.diesel;
          source = 'applegreen_official';
        }
      }
    }

    // Apply updates
    if (Object.keys(updates).length > 0) {
      const setClauses = Object.entries(updates)
        .map(([col], i) => `${col} = $${i + 2}`)
        .join(', ');
      const values = [station.id, ...Object.values(updates)];

      await pool.query(
        `UPDATE stations SET ${setClauses}, last_updated = NOW() WHERE id = $1`,
        values
      );

      // Record in non_gov_prices for attribution
      for (const [fuelCol, price] of Object.entries(updates)) {
        const fuelType = fuelCol === 'petrol_price' ? 'petrol'
                       : fuelCol === 'diesel_price' ? 'diesel' : 'e10';
        await pool.query(`
          INSERT INTO non_gov_prices (station_id, fuel_type, price_pence, source, scraped_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (station_id, fuel_type) DO UPDATE SET
            price_pence = EXCLUDED.price_pence,
            source = EXCLUDED.source,
            scraped_at = NOW()
        `, [station.id, fuelType, price, source]);
      }

      filled++;
    }
  }

  console.log(`[NonGov] Filled ${filled} stations with non-gov prices.`);
  return { filled };
}

module.exports = { fillMissingPrices, scrapeApplegreen };

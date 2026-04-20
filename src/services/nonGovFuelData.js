'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const { getPool } = require('../config/db');

/**
 * nonGovFuelData.js — Sprint 14 dynamic scraper rewrite
 *
 * Fills missing/NULL prices for ANY brand by live-scraping competitor sites
 * per-postcode. This is a dynamic workaround so users never see gaps.
 *
 * Sources (scraped per unique postcode of stations with missing data):
 *  1. PetrolMap.co.uk  — search by postcode, returns nearby stations
 *  2. Applegreen official — bulk HTML table (all Applegreen sites)
 *
 * Matching: fuzzy name + address matching to link scraped data back to
 * our stations rows. Never overwrites valid gov prices.
 *
 * Sets *_source = 'scraped' on filled columns so the frontend can show
 * a (GOV) badge on gov-sourced prices.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SCRAPE_TIMEOUT = 15000;
const MAX_POSTCODES_PER_RUN = 80; // rate-limit safety

// --------------- Scrapers ---------------

/**
 * Scrape PetrolMap for a single postcode.
 * Returns array of { name, address, petrol, diesel, e10, source }.
 */
async function scrapePetrolMap(postcode) {
  const prices = [];
  try {
    const clean = postcode.replace(/\s+/g, '').toUpperCase();
    const resp = await axios.get(
      `https://petrolmap.co.uk/petrol-prices/search/${encodeURIComponent(clean)}`,
      { headers: { 'User-Agent': USER_AGENT }, timeout: SCRAPE_TIMEOUT }
    );
    const $ = cheerio.load(resp.data);

    // PetrolMap renders station cards with price info
    $('.station-card, .result-item, table tbody tr').each((_, el) => {
      const $el = $(el);
      // Try card-style layout
      let name = $el.find('.station-name, .name, h3, h4').first().text().trim();
      let addr = $el.find('.station-address, .address, .location').first().text().trim();
      let petrol = parsePrice($el.find('.e5-price, .petrol-price, .unleaded-price').first().text());
      let e10 = parsePrice($el.find('.e10-price').first().text());
      let diesel = parsePrice($el.find('.diesel-price, .b7-price').first().text());

      // Fallback: table row layout
      if (!name) {
        const cells = $el.find('td');
        if (cells.length >= 4) {
          name = $(cells[0]).text().trim();
          addr = $(cells[1]).text().trim();
          petrol = parsePrice($(cells[2]).text());
          diesel = parsePrice($(cells[3]).text());
          if (cells.length >= 5) e10 = parsePrice($(cells[4]).text());
        }
      }

      if (name && (petrol || diesel || e10)) {
        prices.push({ name, address: addr, petrol, diesel, e10, source: 'petrolmap' });
      }
    });
  } catch (err) {
    console.warn(`[NonGov] PetrolMap scrape failed for ${postcode}:`, err.message);
  }
  return prices;
}

/**
 * Scrape Applegreen official pricing page (bulk — all UK sites).
 */
async function scrapeApplegreen() {
  const prices = [];
  try {
    const resp = await axios.get('https://applegreenstores.com/uk-fuel-pricing/', {
      headers: { 'User-Agent': USER_AGENT },
      timeout: SCRAPE_TIMEOUT,
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
          prices.push({ name: 'Applegreen', address, postcode, petrol: unleaded, diesel, e10: null, source: 'applegreen_official' });
        }
      }
    });
  } catch (err) {
    console.warn('[NonGov] Applegreen scrape failed:', err.message);
  }
  return prices;
}

// --------------- Helpers ---------------

function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.]/g, '');
  const val = parseFloat(cleaned);
  if (isNaN(val) || val < 50 || val > 400) return null;
  return Math.round(val * 10) / 10; // pence/litre, keep 1 decimal place
}

/** Normalise a string for fuzzy comparison. */
function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Score how well a scraped entry matches a station.
 * Higher = better. 0 = no match.
 */
function matchScore(station, scraped) {
  const sName = norm(station.name);
  const sAddr = norm(station.address);
  const sBrand = norm(station.brand);
  const pName = norm(scraped.name);
  const pAddr = norm(scraped.address);

  let score = 0;
  // Brand appears in scraped name
  if (sBrand && pName.includes(sBrand)) score += 3;
  // Station name overlap
  if (sName && pName && (pName.includes(sName) || sName.includes(pName))) score += 4;
  // Address overlap
  if (sAddr && pAddr) {
    const addrWords = sAddr.split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const hits = addrWords.filter(w => pAddr.includes(w)).length;
    if (hits >= 2) score += 3;
    if (hits >= 3) score += 2;
  }
  return score;
}

// --------------- Main fill logic ---------------

/**
 * fillMissingPrices — called by ingestService after gov data sync.
 *
 * 1. Query ALL stations with any NULL price.
 * 2. Collect unique postcodes.
 * 3. For each postcode, live-scrape PetrolMap.
 * 4. Also scrape Applegreen official (bulk).
 * 5. Fuzzy-match scraped results to our stations.
 * 6. UPDATE only NULL fields, set *_source = 'scraped'.
 * 7. Record attribution in non_gov_prices.
 */
async function fillMissingPrices() {
  const pool = getPool();
  console.log('[NonGov] Starting dynamic non-gov price fill...');
  let filled = 0;

  // 1. Get ALL stations with any missing price
  const { rows: missing } = await pool.query(`
    SELECT id, brand, name, address, postcode,
           petrol_price, diesel_price, e10_price
    FROM stations
    WHERE (petrol_price IS NULL OR diesel_price IS NULL OR e10_price IS NULL)
      AND postcode IS NOT NULL AND postcode <> ''
  `);

  if (missing.length === 0) {
    console.log('[NonGov] No missing prices found.');
    return { filled: 0 };
  }
  console.log(`[NonGov] Found ${missing.length} stations with missing prices.`);

  // 2. Collect unique postcodes (outcode level for efficiency)
  const postcodeSet = new Set();
  for (const s of missing) {
    const pc = (s.postcode || '').trim().toUpperCase();
    if (pc.length >= 2) {
      // Use full postcode for precision
      postcodeSet.add(pc.replace(/\s+/g, ''));
    }
  }
  const postcodes = [...postcodeSet].slice(0, MAX_POSTCODES_PER_RUN);
  console.log(`[NonGov] Scraping ${postcodes.length} unique postcodes...`);

  // 3. Scrape PetrolMap per postcode (with small delay to be polite)
  const allScraped = [];
  for (const pc of postcodes) {
    const results = await scrapePetrolMap(pc);
    allScraped.push(...results);
    // Small delay between requests
    if (postcodes.length > 5) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  console.log(`[NonGov] PetrolMap returned ${allScraped.length} scraped entries.`);

  // 4. Also scrape Applegreen official (bulk)
  const agPrices = await scrapeApplegreen();
  console.log(`[NonGov] Applegreen official returned ${agPrices.length} entries.`);

  // Combine all scraped data
  const combined = [...allScraped, ...agPrices];

  // 5. For each station with missing data, find best match
  for (const station of missing) {
    const updates = {};
    const sources = {};

    // Find best matching scraped entry
    let bestMatch = null;
    let bestScore = 0;

    for (const scraped of combined) {
      // If scraped entry has a postcode, check proximity
      if (scraped.postcode) {
        const sp = norm(scraped.postcode);
        const stP = norm(station.postcode);
        if (sp !== stP) continue; // postcode must match for Applegreen
      }
      const score = matchScore(station, scraped);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = scraped;
      }
    }

    // Require minimum confidence
    if (bestMatch && bestScore >= 4) {
      if (!station.petrol_price && bestMatch.petrol) {
        updates.petrol_price = bestMatch.petrol;
        sources.petrol_price = bestMatch.source;
      }
      if (!station.diesel_price && bestMatch.diesel) {
        updates.diesel_price = bestMatch.diesel;
        sources.diesel_price = bestMatch.source;
      }
      if (!station.e10_price && bestMatch.e10) {
        updates.e10_price = bestMatch.e10;
        sources.e10_price = bestMatch.source;
      }
    }

    // 6. Apply updates
    if (Object.keys(updates).length > 0) {
      const setParts = [];
      const values = [station.id];
      let idx = 2;

      for (const [col, price] of Object.entries(updates)) {
        setParts.push(`${col} = $${idx}`);
        values.push(price);
        idx++;
        // Also set the source column
        const srcCol = col.replace('_price', '_source');
        setParts.push(`${srcCol} = $${idx}`);
        values.push(sources[col] || 'scraped');
        idx++;
      }
      setParts.push('last_updated = NOW()');

      await pool.query(
        `UPDATE stations SET ${setParts.join(', ')} WHERE id = $1`,
        values
      );

      // 7. Record in non_gov_prices for attribution
      for (const [col, price] of Object.entries(updates)) {
        const fuelType = col === 'petrol_price' ? 'petrol'
                       : col === 'diesel_price' ? 'diesel' : 'e10';
        await pool.query(`
          INSERT INTO non_gov_prices (station_id, fuel_type, price_pence, source, scraped_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (station_id, fuel_type) DO UPDATE SET
            price_pence = EXCLUDED.price_pence,
            source = EXCLUDED.source,
            scraped_at = NOW()
        `, [station.id, fuelType, price, sources[col] || 'scraped']);
      }

      filled++;
    }
  }

  console.log(`[NonGov] Filled ${filled} stations with live-scraped prices.`);
  return { filled };
}

module.exports = { fillMissingPrices, scrapePetrolMap, scrapeApplegreen };

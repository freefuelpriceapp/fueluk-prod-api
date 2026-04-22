'use strict';

/**
 * brandNormalizer.js
 * Normalises brand names for deduplication and display.
 *
 * Two concerns:
 *   1. `normalizeBrandKey` — strips casing/punctuation + applies alias groups,
 *      so "Sainsburys" and "SAINSBURY'S" collapse into one key for grouping.
 *   2. `canonicalBrandName` — returns the DISPLAY brand shown to clients:
 *      title-cased, with operator names (e.g. "Motor Fuel Group") mapped to
 *      the forecourt brand that actually appears on signage ("Esso").
 */

// Maps normalized keys (uppercase, punctuation stripped) to canonical display
// names. Used by both the key function (for grouping) and canonicalBrandName
// (for the string returned to clients).
const BRAND_ALIASES = {
  NICHOLL: 'Nicholls',
  NICHOLLS: 'Nicholls',
  HIGHLANDFUELS: 'Highland Fuels',
  HIGHLANDFUELSLTD: 'Highland Fuels',
  // Operator -> forecourt brand. MFG operates Esso-branded sites under licence;
  // our upstream CMA feed sometimes reports the operator instead of the brand,
  // so the same physical forecourt appears as "Motor Fuel Group" in /nearby
  // and "ESSO" in /search. Map the operator name onto the display brand.
  MOTORFUELGROUP: 'Esso',
  MFG: 'Esso',
  MFGEXPRESSWAY: 'Esso',
  // EG Group (formerly Euro Garages) operates Applegreen-branded forecourts
  // in the UK. Upstream feeds sometimes report the holding-company name
  // ("EG On The Move", "EG Group") instead of the consumer-facing brand
  // ("Applegreen"), so the same physical forecourt appears under different
  // names in /nearby vs /cheapest. Map the operator names to the signage brand.
  EG: 'Applegreen',
  EGGROUP: 'Applegreen',
  EGONTHEMOVE: 'Applegreen',
  EUROGARAGES: 'Applegreen',
  // Display casing for well-known brands (the CMA feed mixes "ESSO", "Esso",
  // "SHELL", "Shell", etc. — we pick one).
  ESSO: 'Esso',
  SHELL: 'Shell',
  BP: 'BP',
  TEXACO: 'Texaco',
  TESCO: 'Tesco',
  ASDA: 'Asda',
  ASDAEXPRESS: 'Asda Express',
  MORRISONS: 'Morrisons',
  SAINSBURYS: "Sainsbury's",
  COSTCO: 'Costco',
  COSTCOWHOLESALE: 'Costco',
  APPLEGREEN: 'Applegreen',
  JET: 'Jet',
  GULF: 'Gulf',
  MURCO: 'Murco',
  HARVESTENERGY: 'Harvest Energy',
  TOTAL: 'Total',
  TOTALENERGIES: 'Total',
};

function stripPunctuation(s) {
  if (s == null) return '';
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeBrandKey(brand) {
  if (brand == null) return '';
  const stripped = stripPunctuation(brand);
  return BRAND_ALIASES[stripped] ? stripPunctuation(BRAND_ALIASES[stripped]) : stripped;
}

function titleCase(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, ch) => ch.toUpperCase());
}

function canonicalBrandName(brand) {
  if (brand == null) return brand;
  const trimmed = String(brand).trim();
  if (!trimmed) return trimmed;
  const stripped = stripPunctuation(trimmed);
  if (BRAND_ALIASES[stripped]) return BRAND_ALIASES[stripped];
  // No alias match — apply display casing so we never return SHOUTING brands.
  // 2-char acronyms (e.g. "BP") stay uppercase; everything else is title case.
  if (trimmed.length <= 3 && trimmed === trimmed.toUpperCase()) return trimmed;
  return titleCase(trimmed);
}

/**
 * For a user-supplied brand filter value, return every punctuation-stripped
 * uppercase key that should match. This expands alias groups so that filtering
 * by "Nicholls" also matches stations stored as "Nicholl", and filtering by
 * "Esso" also matches stations stored as "Motor Fuel Group".
 */
function normalizedKeysForBrandFilter(brand) {
  if (brand == null) return [];
  const stripped = stripPunctuation(brand);
  if (!stripped) return [];
  const groupKey = BRAND_ALIASES[stripped] ? stripPunctuation(BRAND_ALIASES[stripped]) : stripped;
  const keys = new Set([stripped, groupKey]);
  for (const [alias, canonical] of Object.entries(BRAND_ALIASES)) {
    if (stripPunctuation(canonical) === groupKey) keys.add(alias);
  }
  return [...keys];
}

module.exports = {
  normalizeBrandKey,
  canonicalBrandName,
  normalizedKeysForBrandFilter,
  BRAND_ALIASES,
};

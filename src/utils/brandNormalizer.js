'use strict';

/**
 * brandNormalizer.js
 * Normalises brand names for deduplication so that variants like
 * "Sainsburys" and "SAINSBURY'S" collapse into a single group.
 *
 * Strategy:
 *   1. Uppercase + trim whitespace.
 *   2. Strip all non-alphanumeric characters (apostrophes, hyphens, dots, etc.).
 *   3. Apply an explicit alias map for known duplicates that punctuation
 *      stripping alone can't catch (e.g. "Nicholl" -> "Nicholls").
 *
 * The normalized key is used only for grouping. The display name returned to
 * clients is picked from the most common variant within each group (falling
 * back to the alias map's canonical name when one is defined).
 */

const BRAND_ALIASES = {
  NICHOLL: 'Nicholls',
  NICHOLLS: 'Nicholls',
  HIGHLANDFUELS: 'Highland Fuels',
  HIGHLANDFUELSLTD: 'Highland Fuels',
};

function stripPunctuation(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeBrandKey(brand) {
  if (brand == null) return '';
  const stripped = stripPunctuation(brand);
  return BRAND_ALIASES[stripped] ? stripPunctuation(BRAND_ALIASES[stripped]) : stripped;
}

function canonicalBrandName(brand) {
  if (brand == null) return brand;
  const stripped = stripPunctuation(brand);
  if (BRAND_ALIASES[stripped]) return BRAND_ALIASES[stripped];
  return String(brand).trim();
}

/**
 * For a user-supplied brand filter value, return every punctuation-stripped
 * uppercase key that should match. This expands alias groups so that filtering
 * by "Nicholls" also matches stations stored as "Nicholl".
 */
function normalizedKeysForBrandFilter(brand) {
  const stripped = stripPunctuation(brand);
  if (!stripped) return [];
  const groupKey = BRAND_ALIASES[stripped] ? stripPunctuation(BRAND_ALIASES[stripped]) : stripped;
  const keys = new Set([stripped, groupKey]);
  for (const [alias, canonical] of Object.entries(BRAND_ALIASES)) {
    if (stripPunctuation(canonical) === groupKey) keys.add(alias);
  }
  return [...keys];
}

module.exports = { normalizeBrandKey, canonicalBrandName, normalizedKeysForBrandFilter, BRAND_ALIASES };

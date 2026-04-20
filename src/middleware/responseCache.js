'use strict';

/**
 * responseCache.js
 * In-memory LRU-style response cache for GET endpoints.
 *
 * - Pure JS Map-based TTL cache, no external deps.
 * - LRU eviction once entries exceed MAX_ENTRIES (default 500).
 * - Cache key: `${req.path}?${sorted_query_params}` (lat/lon rounded to
 *   3 decimal places — ~110m — to improve hit rate on GPS inputs).
 * - Adds `X-Cache: HIT|MISS` so clients/tests can inspect behaviour.
 * - `clearCache()` drops all entries (called by ingest after a fresh sync).
 */

const MAX_ENTRIES = parseInt(process.env.RESPONSE_CACHE_MAX || '500', 10);

const store = new Map(); // key -> { body, status, contentType, expiresAt }

function now() { return Date.now(); }

function roundCoord(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toFixed(3);
}

function buildKey(req) {
  const q = req.query || {};
  const keys = Object.keys(q).sort();
  const parts = keys.map(k => {
    let val = q[k];
    if (k === 'lat' || k === 'lon') val = roundCoord(val);
    return `${k}=${val}`;
  });
  return `${req.path}?${parts.join('&')}`;
}

function setEntry(key, entry) {
  // Refresh LRU ordering: delete first so re-insert puts it at the tail.
  if (store.has(key)) store.delete(key);
  store.set(key, entry);
  while (store.size > MAX_ENTRIES) {
    // Oldest-inserted key is first in Map iteration order.
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

function getEntry(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now()) {
    store.delete(key);
    return null;
  }
  // Refresh LRU position.
  store.delete(key);
  store.set(key, entry);
  return entry;
}

function clearCache() {
  store.clear();
}

function cacheSize() {
  return store.size;
}

/**
 * cacheFor(ttlSeconds)
 * Express middleware factory. Caches successful JSON responses.
 */
function cacheFor(ttlSeconds) {
  const ttlMs = ttlSeconds * 1000;
  return function responseCache(req, res, next) {
    if (req.method !== 'GET') return next();

    const key = buildKey(req);
    const hit = getEntry(key);
    if (hit) {
      res.setHeader('X-Cache', 'HIT');
      if (hit.contentType) res.setHeader('Content-Type', hit.contentType);
      return res.status(hit.status).send(hit.body);
    }

    res.setHeader('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = function cachingJson(body) {
      // Only cache 2xx success responses.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setEntry(key, {
          body: JSON.stringify(body),
          status: res.statusCode,
          contentType: 'application/json; charset=utf-8',
          expiresAt: now() + ttlMs,
        });
      }
      return originalJson(body);
    };

    return next();
  };
}

module.exports = { cacheFor, clearCache, cacheSize, _buildKey: buildKey };

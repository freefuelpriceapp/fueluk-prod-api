'use strict';

/**
 * rateLimiter.js
 * In-memory rate limiter middleware for the FreeFuelPrice API.
 * Uses a sliding-window-ish approach: a window opens on first request and
 * closes `windowMs` later; within the window, count is incremented and the
 * bucket resets once the window expires.
 *
 * Two flavours:
 *   - createRateLimiter(max, windowMs): classic per-IP bucket.
 *   - createDeviceRateLimiter({ deviceMax, deviceWindowMs, ipMax, ipWindowMs }):
 *     cap per SHA-256-hashed device_id when present (X-Device-ID header
 *     or ?device_id= query param), falling back to a generous per-IP bucket
 *     when the client doesn't supply one. Shared networks therefore don't
 *     poison each other, while unauthenticated scripts still have a ceiling.
 *
 * No external dependency — safe for AWS ECS / App Runner.
 */

const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const store = new Map(); // key -> { count, resetAt }

function cleanup() {
  const now = Date.now();
  for (const [key, record] of store.entries()) {
    if (record.resetAt < now) store.delete(key);
  }
}

// Run cleanup every 5 minutes to prevent memory leaks
setInterval(cleanup, 5 * 60 * 1000).unref();

function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function hashDeviceId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Basic UUID-ish shape check — any non-empty string is accepted as a
  // device id, but we hash before storing/logging so the raw value never
  // touches memory beyond this function.
  return crypto.createHash('sha256').update(trimmed).digest('hex');
}

function getDeviceHash(req) {
  const raw =
    (typeof req.headers['x-device-id'] === 'string' && req.headers['x-device-id']) ||
    (typeof req.query?.device_id === 'string' && req.query.device_id) ||
    null;
  return hashDeviceId(raw);
}

function checkAndIncrement(key, max, windowMs) {
  const now = Date.now();
  const record = store.get(key);
  if (!record || record.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(0, max - 1), retryAfter: 0, resetAt: now + windowMs };
  }
  record.count += 1;
  if (record.count > max) {
    const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, retryAfter, resetAt: record.resetAt };
  }
  return {
    allowed: true,
    remaining: Math.max(0, max - record.count),
    retryAfter: 0,
    resetAt: record.resetAt,
  };
}

/**
 * Creates a classic per-IP rate limiter middleware.
 */
function createRateLimiter(max = 100, windowMs = WINDOW_MS) {
  return function rateLimiter(req, res, next) {
    const ip = getIp(req);
    const key = `ip:${ip}`;
    const result = checkAndIncrement(key, max, windowMs);

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      return res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${result.retryAfter}s.`,
        retryAfter: result.retryAfter,
        retry_after_seconds: result.retryAfter,
      });
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    return next();
  };
}

/**
 * Creates a per-device daily rate limiter with a per-IP fallback.
 * Keys off SHA-256(X-Device-ID || ?device_id). When neither is supplied,
 * falls back to a more generous per-IP bucket so scripts/curl still have a
 * ceiling without poisoning real users on shared networks.
 *
 * Logs limit hits at INFO — never logs the raw device_id or IP.
 *
 * @param {object} opts
 * @param {number} opts.deviceMax - max requests per device per window
 * @param {number} opts.deviceWindowMs - device window (default 24h)
 * @param {number} opts.ipMax - max requests per IP when no device_id supplied
 * @param {number} opts.ipWindowMs - IP window (default 1h)
 * @param {string} [opts.label] - short label for log lines (e.g. "vehicleLookup")
 */
function createDeviceRateLimiter(opts = {}) {
  const deviceMax = opts.deviceMax ?? 30;
  const deviceWindowMs = opts.deviceWindowMs ?? 24 * 60 * 60 * 1000;
  const ipMax = opts.ipMax ?? 60;
  const ipWindowMs = opts.ipWindowMs ?? 60 * 60 * 1000;
  const label = opts.label || 'rateLimit';

  return function deviceRateLimiter(req, res, next) {
    const deviceHash = getDeviceHash(req);
    let key;
    let max;
    let windowMs;
    let scope;

    if (deviceHash) {
      key = `dev:${deviceHash}`;
      max = deviceMax;
      windowMs = deviceWindowMs;
      scope = 'device';
    } else {
      const ip = getIp(req);
      // Hash the IP too so the key we hold in memory is not the raw address.
      const ipHash = crypto.createHash('sha256').update(String(ip)).digest('hex');
      key = `ip:${ipHash}`;
      max = ipMax;
      windowMs = ipWindowMs;
      scope = 'ip';
    }

    const result = checkAndIncrement(key, max, windowMs);

    if (!result.allowed) {
      // INFO log — key prefix only, never raw device_id / IP.
      console.info(JSON.stringify({
        level: 'info',
        event: 'rate_limit_hit',
        limiter: label,
        scope,
        limit: max,
        window_ms: windowMs,
        retry_after_seconds: result.retryAfter,
      }));
      res.setHeader('Retry-After', result.retryAfter);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Scope', scope);
      return res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: scope === 'device'
          ? `Daily lookup limit reached. Try again in ${result.retryAfter}s.`
          : `Rate limit exceeded. Try again in ${result.retryAfter}s.`,
        retry_after_seconds: result.retryAfter,
        retryAfter: result.retryAfter,
        scope,
      });
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Scope', scope);
    return next();
  };
}

function _resetStoreForTests() {
  store.clear();
}

// Pre-built limiters
const generalLimiter = createRateLimiter(100);
const strictLimiter = createRateLimiter(10); // for price submissions

module.exports = {
  createRateLimiter,
  createDeviceRateLimiter,
  generalLimiter,
  strictLimiter,
  _resetStoreForTests,
  _hashDeviceId: hashDeviceId,
};

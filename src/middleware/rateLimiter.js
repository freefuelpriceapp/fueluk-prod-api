'use strict';

/**
 * rateLimiter.js — Sprint 7
 * In-memory rate limiter middleware for the FreeFuelPrice API.
 * Uses a sliding window approach per IP address.
 * No external dependency required — safe for AWS ECS / App Runner.
 *
 * Limits:
 *   - General API:      100 req / 15 min per IP
 *   - Price submission: 10  req / 15 min per IP (stricter)
 */

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const store = new Map(); // ip -> { count, resetAt }

function cleanup() {
  const now = Date.now();
  for (const [ip, record] of store.entries()) {
    if (record.resetAt < now) store.delete(ip);
  }
}

// Run cleanup every 5 minutes to prevent memory leaks
setInterval(cleanup, 5 * 60 * 1000).unref();

/**
 * Creates a rate limiter middleware.
 * @param {number} max - Max requests per window
 * @param {number} windowMs - Window in milliseconds (default 15 min)
 */
function createRateLimiter(max = 100, windowMs = WINDOW_MS) {
  return function rateLimiter(req, res, next) {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    const now = Date.now();
    const record = store.get(ip);

    if (!record || record.resetAt < now) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count += 1;

    if (record.count > max) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', 0);
      return res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
        retryAfter,
      });
    }

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));
    return next();
  };
}

// Pre-built limiters
const generalLimiter = createRateLimiter(100);
const strictLimiter = createRateLimiter(10); // for price submissions

module.exports = { createRateLimiter, generalLimiter, strictLimiter };

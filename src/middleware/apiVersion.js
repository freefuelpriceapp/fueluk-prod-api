'use strict';

/**
 * apiVersion.js
 *
 * Versioning headers, per-request IDs, and a deprecation decorator.
 * No external deps — uses the Node 18+ built-in `crypto.randomUUID()`.
 */

const { randomUUID } = require('crypto');

const CURRENT_VERSION = 1;
const MIN_VERSION = 1;

function apiVersionMiddleware(req, res, next) {
  const requestId = randomUUID();
  req.id = requestId;

  res.setHeader('X-API-Version', String(CURRENT_VERSION));
  res.setHeader('X-API-Min-Version', String(MIN_VERSION));
  res.setHeader('X-API-Deprecation', '');
  res.setHeader('X-Request-Id', requestId);

  const raw = req.headers['x-api-version'];
  if (raw !== undefined && raw !== '') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      req.clientApiVersion = parsed;
      if (parsed < MIN_VERSION) {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'client_api_version_below_min',
          clientApiVersion: parsed,
          minVersion: MIN_VERSION,
          requestId,
          path: req.originalUrl || req.url,
        }));
      }
    }
  }

  next();
}

/**
 * Returns Express middleware that marks a route as deprecated.
 * @param {string} sunsetDate - ISO date (YYYY-MM-DD) when the route will be removed.
 * @param {string} message - Human-readable migration hint.
 */
function deprecated(sunsetDate, message) {
  const sunsetHttpDate = new Date(sunsetDate).toUTCString();
  return function deprecatedMiddleware(req, res, next) {
    res.setHeader('X-API-Deprecation', 'true');
    res.setHeader('Sunset', sunsetHttpDate);
    if (message) res.setHeader('X-API-Deprecation-Message', message);
    next();
  };
}

module.exports = apiVersionMiddleware;
module.exports.apiVersionMiddleware = apiVersionMiddleware;
module.exports.deprecated = deprecated;
module.exports.CURRENT_VERSION = CURRENT_VERSION;
module.exports.MIN_VERSION = MIN_VERSION;

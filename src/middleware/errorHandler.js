/**
 * errorHandler.js
 *
 * Structured JSON error logger + Express error middleware.
 *
 * Emits a single-line JSON record per failure so logs are machine-parseable
 * in CloudWatch / Datadog / Loki without needing a provider SDK at launch.
 *
 * Launch-safe: no remote sink, no PII. Request body is never logged.
 */

function redactQuery(query) {
  if (!query || typeof query !== 'object') return undefined;
  const REDACT = ['lat', 'lng', 'latitude', 'longitude', 'postcode', 'token'];
  const out = {};
  for (const k of Object.keys(query)) {
    out[k] = REDACT.includes(k) ? '[redacted]' : query[k];
  }
  return out;
}

function buildRecord(err, req, status) {
  return {
    ts: new Date().toISOString(),
    level: status >= 500 ? 'error' : 'warn',
    msg: 'request_failed',
    status,
    code: err.code || undefined,
    name: err.name || 'Error',
    message: err.message || 'Internal Server Error',
    method: req && req.method,
    path: req && (req.originalUrl || req.url),
    requestId: req && (req.id || req.headers && req.headers['x-request-id']) || undefined,
    query: req && redactQuery(req.query),
    ip: undefined, // intentionally omitted for privacy
    stack: typeof err.stack === 'string'
      ? err.stack.split('\n').slice(0, 20).join('\n')
      : undefined,
  };
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  const record = buildRecord(err, req, status);

  // Structured single-line JSON log for downstream collectors.
  try {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(record));
  } catch (_) {
    // eslint-disable-next-line no-console
    console.error('request_failed', status, err && err.message);
  }

  if (res.headersSent) return;

  res.status(status).json({
    error: err.message || 'Internal Server Error',
    code: err.code || undefined,
    requestId: record.requestId,
  });
}

module.exports = errorHandler;
module.exports.buildRecord = buildRecord;

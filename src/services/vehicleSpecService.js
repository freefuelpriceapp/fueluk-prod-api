'use strict';

/**
 * vehicleSpecService.js
 * Wraps checkcardetails.co.uk's Vehicle Spec Data API to enrich the
 * bare-bones DVLA response (which often returns "make: LAND ROVER, model: null")
 * with model, variant, trim, body style, transmission, doors, seats, etc.
 *
 * --------------------------------------------------------------------------
 * STATUS: Promoted to "standard" capability. The feature flag default is now
 * ON; setting FEATURE_VEHICLE_SPEC_ENRICHMENT=false explicitly disables it.
 * Without CHECKCARDETAILS_API_KEY the service is a no-op (returns null) so
 * pre-key deploys remain safe.
 *
 * To provision the API key once issued by checkcardetails.co.uk:
 *
 *   # 1. Add the new key to the existing app secret in eu-west-2
 *   AWS_REGION=eu-west-2 \
 *   aws secretsmanager get-secret-value \
 *     --secret-id fuelapp/prod/app \
 *     --query SecretString --output text > /tmp/secret.json
 *   jq '. + {"CHECKCARDETAILS_API_KEY":"PASTE_KEY_HERE"}' /tmp/secret.json > /tmp/secret.new.json
 *   AWS_REGION=eu-west-2 \
 *   aws secretsmanager put-secret-value \
 *     --secret-id fuelapp/prod/app \
 *     --secret-string file:///tmp/secret.new.json
 *   shred -u /tmp/secret.json /tmp/secret.new.json
 *
 *   # 2. Add the secret reference to the task def. The flag no longer needs
 *   #    to be set; the default is on. To explicitly DISABLE, set
 *   #    FEATURE_VEHICLE_SPEC_ENRICHMENT=false.
 *   AWS_REGION=eu-west-2 \
 *   aws ecs describe-task-definition --task-definition fueluk-prod-api \
 *     --query 'taskDefinition' > /tmp/td.json
 *   jq '
 *     .containerDefinitions[0].secrets += [{
 *       "name":"CHECKCARDETAILS_API_KEY",
 *       "valueFrom":"arn:aws:secretsmanager:eu-west-2:<ACCOUNT_ID>:secret:fuelapp/prod/app:CHECKCARDETAILS_API_KEY::"
 *     }]
 *     | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,
 *           .compatibilities,.registeredAt,.registeredBy)
 *   ' /tmp/td.json > /tmp/td.new.json
 *   AWS_REGION=eu-west-2 \
 *   aws ecs register-task-definition --cli-input-json file:///tmp/td.new.json
 *   AWS_REGION=eu-west-2 \
 *   aws ecs update-service \
 *     --cluster fuelapp-prod-cluster \
 *     --service fueluk-prod-service \
 *     --task-definition fueluk-prod-api \
 *     --force-new-deployment
 *
 * Confirm enrichment is live by hitting GET /api/v1/diagnostics — the
 * `vehicle_spec.key_present` field flips to true and `last_24h_calls`
 * starts incrementing once the first lookup runs.
 * --------------------------------------------------------------------------
 *
 * Env vars:
 *   CHECKCARDETAILS_API_KEY              upstream auth (required)
 *   CHECKCARDETAILS_API_BASE             default https://api.checkcardetails.co.uk/vehicledata
 *   FEATURE_VEHICLE_SPEC_ENRICHMENT      default ON; "false" disables
 *
 * Behaviour:
 *   - Returns a normalised object on success; null on any failure (4xx/5xx,
 *     timeout, malformed JSON, flag off, key missing). Never throws.
 *   - Positive cache: 30 days per uppercase-no-spaces reg.
 *   - Negative cache: 24h on 404 ("not in upstream DB") and 403 ("premium
 *     tier not authorised") so we don't hammer the API on the free tier.
 *   - Client-side 10 req/s ceiling.
 *
 * Endpoints:
 *   - {base}/vehicleregistration  — £0.02 tier (make, model, fuel, year)
 *   - {base}/ukvehicledata        — £0.10 tier (adds trim/variant/transmission/
 *     doors). Requires premium access via
 *     api.checkcardetails.co.uk/support/premiumdatarequest. Returns 403
 *     until granted; we negative-cache that for 24h.
 */

const DEFAULT_API_BASE = 'https://api.checkcardetails.co.uk/vehicledata';
const DEFAULT_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_ENTRIES = 5000;
const RATE_LIMIT_PER_SECOND = 10;
const METRIC_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

function isFlagEnabled() {
  // Default ON. Only an explicit "false" disables enrichment.
  const raw = process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT;
  if (raw === undefined || raw === null || raw === '') return true;
  return String(raw).toLowerCase() !== 'false';
}

function isConfigured() {
  return isFlagEnabled() && Boolean(process.env.CHECKCARDETAILS_API_KEY);
}

function isEnrichmentEnabled() {
  return isConfigured();
}

function getApiBase() {
  return process.env.CHECKCARDETAILS_API_BASE || DEFAULT_API_BASE;
}

function normaliseReg(reg) {
  return String(reg || '').replace(/\s+/g, '').toUpperCase();
}

// ---- in-memory cache ------------------------------------------------------

const cache = new Map(); // reg -> { value, expiresAt }

function cacheGet(reg) {
  const entry = cache.get(reg);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(reg);
    return null;
  }
  return entry;
}

function cacheSet(reg, value, ttlMs) {
  if (cache.has(reg)) cache.delete(reg);
  cache.set(reg, { value, expiresAt: Date.now() + ttlMs, negative: value === null });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function clearCache() { cache.clear(); }

// ---- rate limit (token bucket, 10 req/s) ----------------------------------

let tokens = RATE_LIMIT_PER_SECOND;
let lastRefill = Date.now();

function tryConsumeToken() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  if (elapsed > 0) {
    tokens = Math.min(RATE_LIMIT_PER_SECOND, tokens + elapsed * RATE_LIMIT_PER_SECOND);
    lastRefill = now;
  }
  if (tokens >= 1) {
    tokens -= 1;
    return true;
  }
  return false;
}

function _resetRateLimitForTests() {
  tokens = RATE_LIMIT_PER_SECOND;
  lastRefill = Date.now();
}

// ---- metrics (rolling 24h, used by /api/v1/diagnostics) -------------------

const metrics = {
  calls: [],          // timestamps of upstream attempts
  errors: [],         // timestamps of upstream failures (any non-success)
  premiumHits: [],    // timestamps of responses where trim was non-null
};

function _pruneMetrics(now = Date.now()) {
  const cutoff = now - METRIC_WINDOW_MS;
  for (const k of ['calls', 'errors', 'premiumHits']) {
    while (metrics[k].length && metrics[k][0] < cutoff) metrics[k].shift();
  }
}

function _recordCall() { metrics.calls.push(Date.now()); _pruneMetrics(); }
function _recordError() { metrics.errors.push(Date.now()); _pruneMetrics(); }
function _recordPremiumHit() { metrics.premiumHits.push(Date.now()); _pruneMetrics(); }

function getMetricsSnapshot() {
  _pruneMetrics();
  return {
    last_24h_calls: metrics.calls.length,
    last_24h_errors: metrics.errors.length,
    premium_tier_authorised: metrics.premiumHits.length > 0,
  };
}

function _resetMetricsForTests() {
  metrics.calls = [];
  metrics.errors = [];
  metrics.premiumHits = [];
}

// ---- upstream call --------------------------------------------------------

function buildRequest(reg) {
  // checkcardetails.co.uk uses ?apikey= query param, not header.
  // Endpoint is /vehicleregistration (Vehicle Registration tier, £0.02/lookup,
  // returns make, model, colour, fuel, year, engine, tax, MOT). The fuller
  // /ukvehicledata tier (with trim/variant/transmission/doors) requires a
  // separate "premium data" access request — see backlog.
  const key = encodeURIComponent(process.env.CHECKCARDETAILS_API_KEY || '');
  const url = `${getApiBase()}/vehicleregistration?apikey=${key}&vrm=${encodeURIComponent(reg)}`;
  const headers = { Accept: 'application/json' };
  return { url, headers };
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Normalise the upstream payload into our public schema. Upstreams differ in
 * shape (sometimes nested under `data` or `vehicle`); pull from the most
 * common locations and default missing fields to null.
 */
function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw.data || raw.vehicle || raw.result || raw;
  const spec = root.spec || root.vehicleSpec || root.specification || root;

  return {
    model: pick(spec, 'model', 'modelName') || pick(root, 'model'),
    variant: pick(spec, 'variant', 'modelVariant', 'series'),
    trim: pick(spec, 'trim', 'trimLevel'),
    derivative: pick(spec, 'derivative', 'derivativeName'),
    bodyStyle: pick(spec, 'bodyStyle', 'bodyType', 'body'),
    transmission: pick(spec, 'transmission', 'transmissionType', 'gearbox'),
    doors: toInt(pick(spec, 'doors', 'numberOfDoors', 'doorCount')),
    seats: toInt(pick(spec, 'seats', 'numberOfSeats', 'seatingCapacity')),
    engineDescription: pick(
      spec,
      'engineDescription', 'engine', 'engineModel', 'engineName',
    ),
    fuelDescription: pick(
      spec,
      'fuelDescription', 'fuelType', 'fuel',
    ),
    drivetrain: pick(
      spec,
      'drivetrain', 'driveType', 'wheelDrive', 'driveTrain',
    ),
    // Also surface make + year + colour from spec source so /lookup callers
    // can use the upstream-confirmed values when DVLA is missing them.
    make: pick(spec, 'make') || pick(root, 'make'),
    year: toInt(pick(spec, 'yearOfManufacture', 'year') || pick(root, 'yearOfManufacture')),
    colour: pick(spec, 'colour', 'color') || pick(root, 'colour'),
    source: 'checkcardetails',
    fetchedAt: new Date().toISOString(),
  };
}

function logWarn(payload) {
  // Structured warn log; downstream log aggregation can pick this up.
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: 'warn', service: 'vehicleSpecService', ...payload }));
}

/**
 * Fetch the vehicle spec for a single registration.
 *
 * @param {string} registration
 * @param {object} [opts]
 * @param {(input: any, init?: any) => Promise<any>} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.skipCache]
 * @returns {Promise<object|null>} normalised spec object, or null on any failure
 */
async function fetchVehicleSpec(registration, opts = {}) {
  const reg = normaliseReg(registration);
  if (!reg) return null;

  if (!isFlagEnabled()) return null;
  if (!process.env.CHECKCARDETAILS_API_KEY) {
    // Flag on but key missing — log once-ish (caller doesn't need to know)
    logWarn({ event: 'spec.key_missing', reg });
    return null;
  }

  if (!opts.skipCache) {
    const cached = cacheGet(reg);
    if (cached) return cached.value; // covers both positive (object) and negative (null)
  }

  if (!tryConsumeToken()) {
    logWarn({ event: 'spec.rate_limited', reg });
    return null;
  }

  const fetchImpl = opts.fetchImpl || ((...args) => fetch(...args));
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const { url, headers } = buildRequest(reg);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  _recordCall();
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    _recordError();
    logWarn({
      event: err && err.name === 'AbortError' ? 'spec.timeout' : 'spec.network_error',
      reg,
      message: err && err.message ? err.message : 'unknown',
    });
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    _recordError();
    let bodySnippet = '';
    try { bodySnippet = (await res.text()).slice(0, 200); } catch (_) { /* ignore */ }
    logWarn({ event: 'spec.upstream_http', reg, status: res.status, body: bodySnippet });
    // Negative-cache 403 (premium tier not authorised) and 404 (reg unknown)
    // for 24h so we don't hammer the upstream while access is being granted.
    if (res.status === 403 || res.status === 404) {
      cacheSet(reg, null, NEG_CACHE_TTL_MS);
    }
    return null;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    _recordError();
    logWarn({ event: 'spec.malformed_json', reg, message: err.message });
    return null;
  }

  const normalised = normalise(json);
  if (!normalised) {
    _recordError();
    logWarn({ event: 'spec.empty_payload', reg });
    return null;
  }

  if (normalised.trim) _recordPremiumHit();

  cacheSet(reg, normalised, CACHE_TTL_MS);
  return normalised;
}

module.exports = {
  fetchVehicleSpec,
  normalise,
  normaliseReg,
  isFlagEnabled,
  isConfigured,
  isEnrichmentEnabled,
  clearCache,
  getMetricsSnapshot,
  _resetRateLimitForTests,
  _resetMetricsForTests,
  DEFAULT_API_BASE,
  CACHE_TTL_MS,
  NEG_CACHE_TTL_MS,
  RATE_LIMIT_PER_SECOND,
};

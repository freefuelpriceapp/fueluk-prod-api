'use strict';

/**
 * vehicleSpecService.js
 * Wraps checkcardetails.co.uk's Vehicle Spec Data API to enrich the
 * bare-bones DVLA response (which often returns "make: LAND ROVER, model: null")
 * with model, variant, trim, body style, transmission, doors, seats, etc.
 *
 * --------------------------------------------------------------------------
 * TODO: Wire CHECKCARDETAILS_API_KEY into Secrets Manager and the task def.
 * The feature flag (FEATURE_VEHICLE_SPEC_ENRICHMENT) keeps this OFF until
 * the secret is wired, so deploys are safe today.
 *
 * Once a key has been issued by checkcardetails.co.uk, run:
 *
 *   # 1. Add the new key to the existing app secret in us-east-1
 *   AWS_REGION=us-east-1 \
 *   aws secretsmanager get-secret-value \
 *     --secret-id fuelapp/prod/app \
 *     --query SecretString --output text > /tmp/secret.json
 *   jq '. + {"CHECKCARDETAILS_API_KEY":"PASTE_KEY_HERE"}' /tmp/secret.json > /tmp/secret.new.json
 *   AWS_REGION=us-east-1 \
 *   aws secretsmanager put-secret-value \
 *     --secret-id fuelapp/prod/app \
 *     --secret-string file:///tmp/secret.new.json
 *   shred -u /tmp/secret.json /tmp/secret.new.json
 *
 *   # 2. Bump the task def to inject the new key as an env var. Pull current,
 *   #    add the secret reference, register a new revision, update the service.
 *   AWS_REGION=us-east-1 \
 *   aws ecs describe-task-definition --task-definition fueluk-prod-api \
 *     --query 'taskDefinition' > /tmp/td.json
 *   jq '
 *     .containerDefinitions[0].secrets += [{
 *       "name":"CHECKCARDETAILS_API_KEY",
 *       "valueFrom":"arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:fuelapp/prod/app:CHECKCARDETAILS_API_KEY::"
 *     }]
 *     | .containerDefinitions[0].environment += [
 *         {"name":"FEATURE_VEHICLE_SPEC_ENRICHMENT","value":"true"}
 *       ]
 *     | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,
 *           .compatibilities,.registeredAt,.registeredBy)
 *   ' /tmp/td.json > /tmp/td.new.json
 *   AWS_REGION=us-east-1 \
 *   aws ecs register-task-definition --cli-input-json file:///tmp/td.new.json
 *   AWS_REGION=us-east-1 \
 *   aws ecs update-service \
 *     --cluster fuelapp-prod-cluster \
 *     --service fueluk-prod-service \
 *     --task-definition fueluk-prod-api \
 *     --force-new-deployment
 *
 * Verify in CloudWatch the env var is present and the service starts logging
 * "spec.upstream_ok" lines.
 * --------------------------------------------------------------------------
 *
 * Env vars:
 *   CHECKCARDETAILS_API_KEY              upstream auth (required when flag on)
 *   CHECKCARDETAILS_API_BASE             default https://api.checkcardetails.co.uk/vehicledata
 *   FEATURE_VEHICLE_SPEC_ENRICHMENT      "true" to enable; otherwise OFF
 *
 * Behaviour:
 *   - Returns a normalised object on success; null on any failure (4xx/5xx,
 *     timeout, malformed JSON, flag off, key missing). Never throws.
 *   - Caches per uppercase-no-spaces reg for 30 days.
 *   - Client-side 10 req/s ceiling.
 *
 * NOTE: The exact upstream endpoint shape is documented at
 *   https://api.checkcardetails.co.uk (Vehicle Spec / UK Vehicle Data tier).
 *   This implementation assumes:
 *     GET {base}/vehiclespec?vrm={REG}
 *     header: x-api-key: {CHECKCARDETAILS_API_KEY}
 *   If the docs say otherwise, adjust buildRequest() — it's the only place
 *   the upstream contract leaks.
 */

const DEFAULT_API_BASE = 'https://api.checkcardetails.co.uk/vehicledata';
const DEFAULT_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_CACHE_ENTRIES = 5000;
const RATE_LIMIT_PER_SECOND = 10;

function isFlagEnabled() {
  return String(process.env.FEATURE_VEHICLE_SPEC_ENRICHMENT || '').toLowerCase() === 'true';
}

function isConfigured() {
  return isFlagEnabled() && Boolean(process.env.CHECKCARDETAILS_API_KEY);
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
  return entry.value;
}

function cacheSet(reg, value) {
  if (cache.has(reg)) cache.delete(reg);
  cache.set(reg, { value, expiresAt: Date.now() + CACHE_TTL_MS });
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

// ---- upstream call --------------------------------------------------------

function buildRequest(reg) {
  const url = `${getApiBase()}/vehiclespec?vrm=${encodeURIComponent(reg)}`;
  const headers = {
    'x-api-key': process.env.CHECKCARDETAILS_API_KEY,
    Accept: 'application/json',
  };
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
    if (cached) return cached;
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

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (err) {
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
    let bodySnippet = '';
    try { bodySnippet = (await res.text()).slice(0, 200); } catch (_) { /* ignore */ }
    logWarn({ event: 'spec.upstream_http', reg, status: res.status, body: bodySnippet });
    return null;
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    logWarn({ event: 'spec.malformed_json', reg, message: err.message });
    return null;
  }

  const normalised = normalise(json);
  if (!normalised) {
    logWarn({ event: 'spec.empty_payload', reg });
    return null;
  }

  cacheSet(reg, normalised);
  return normalised;
}

module.exports = {
  fetchVehicleSpec,
  normalise,
  normaliseReg,
  isFlagEnabled,
  isConfigured,
  clearCache,
  _resetRateLimitForTests,
  DEFAULT_API_BASE,
  CACHE_TTL_MS,
  RATE_LIMIT_PER_SECOND,
};

'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { loadSecrets } = require('./config/secrets');
const { initPool } = require('./config/db');
const { runMigrations } = require('./config/migrate');
const healthRouter = require('./routes/health');
const stationsRouter = require('./routes/stations');
const metaRouter = require('./routes/meta');
const pricesRouter = require('./routes/prices');
const alertsRouter = require('./routes/alerts');
const favouritesRouter = require('./routes/favourites');
const premiumRouter = require('./routes/premiumRoutes');
const pagesRouter = require('./routes/pages');
const errorHandler = require('./middleware/errorHandler');
const notFound = require('./middleware/notFound');
const { generalLimiter } = require('./middleware/rateLimiter');
const { scheduleFuelSync } = require('./services/govFuelData');
const { startIngestRunner } = require('./jobs/ingestRunner');
const { startAlertJob } = require('./jobs/alertJob');
const { startRetentionJob } = require('./jobs/retentionJob');

const PORT = process.env.PORT || 3000;

// Explicit allowlist — includes Expo Snack preview origins, localhost dev,
// Expo Go, and production web/app domains. Null origin permitted for
// server-to-server and native fetches without Origin header.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/snack\.expo\.dev$/,
  /^https:\/\/([a-z0-9-]+\.)?snack\.expo\.io$/,
  /^https:\/\/snack-web-player\.s3[.-][a-z0-9-]+\.amazonaws\.com$/,
  /^https:\/\/.*\.exp\.direct$/,
  /^https:\/\/expo\.dev$/,
  /^https:\/\/([a-z0-9-]+\.)?expo\.dev$/,
  /^https:\/\/freefuelprice\.app$/,
  /^https:\/\/([a-z0-9-]+\.)?freefuelprice\.app$/,
];

function corsOriginCheck(origin, cb) {
  // Native mobile fetches and same-origin server calls have no Origin header
  if (!origin) return cb(null, true);
  const ok = ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
  if (ok) return cb(null, true);
  return cb(new Error(`CORS: origin ${origin} not allowed`));
}

const corsOptions = {
  origin: corsOriginCheck,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Api-Version'],
  exposedHeaders: ['X-Request-Id'],
  credentials: false,
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

async function start() {
  await loadSecrets();
  await initPool();
  await runMigrations();

  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(express.json());

  // Health check - exactly /health (no prefix)
  app.use('/health', healthRouter);

  // Apply rate limiter to all API v1 routes
  app.use('/api/v1', generalLimiter);

  // API v1 routes
  app.use('/api/v1/stations', stationsRouter);
  app.use('/api/v1/meta', metaRouter);
  app.use('/api/v1/prices', pricesRouter);
  app.use('/api/v1/alerts', alertsRouter);
  app.use('/api/v1/favourites', favouritesRouter);
  app.use('/api/v1/premium', premiumRouter);

  // Public pages (privacy, support)
  app.use(pagesRouter);

  // 404 handler (must be after all routes)
  app.use(notFound);

  // Error handler (must be last)
  app.use(errorHandler);

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Start background jobs
    scheduleFuelSync();
    startIngestRunner();
    startAlertJob();
    startRetentionJob();
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

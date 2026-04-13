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
const errorHandler = require('./middleware/errorHandler');
const notFound = require('./middleware/notFound');
const { generalLimiter } = require('./middleware/rateLimiter');
const { scheduleFuelSync } = require('./services/govFuelData');
const { startIngestRunner } = require('./jobs/ingestRunner');
const { startAlertJob } = require('./jobs/alertJob');
const { startRetentionJob } = require('./jobs/retentionJob');

const PORT = process.env.PORT || 3000;

async function start() {
  await loadSecrets();
  await initPool();
  await runMigrations();

  const app = express();
  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: '*' }));
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

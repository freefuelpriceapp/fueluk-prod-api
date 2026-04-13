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
const errorHandler = require('./middleware/errorHandler');
const { scheduleFuelSync } = require('./services/govFuelData');
const { startIngestRunner } = require('./jobs/ingestRunner');

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

  // API v1 routes
  app.use('/api/v1/stations', stationsRouter);
  app.use('/api/v1/meta', metaRouter);
  app.use('/api/v1/prices', pricesRouter);

  // Status endpoint
  app.get('/api/v1/status', (req, res) => {
    res.json({
      status: 'ok',
      version: '4.0.0',
      timestamp: new Date().toISOString()
    });
  });

  app.use(errorHandler);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FreeFuelPrice API v4.0.0 listening on port ${PORT}`);
    scheduleFuelSync();
    startIngestRunner();
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

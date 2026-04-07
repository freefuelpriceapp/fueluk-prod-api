'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { loadSecrets } = require('./config/secrets');
const { initPool } = require('./config/db');
const healthRouter = require('./routes/health');
const stationsRouter = require('./routes/stations');
const { errorHandler } = require('./middleware/errorHandler');
const { scheduleFuelSync } = require('./services/govFuelData');

const PORT = process.env.PORT || 3000;

async function start() {
  await loadSecrets();
  await initPool();

  const app = express();
  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: '*' }));
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/stations', stationsRouter);

  app.use(errorHandler);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FreeFuelPrice API v4.0.0 listening on port ${PORT}`);
    scheduleFuelSync();
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

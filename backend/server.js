require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const { validateEnvironment } = require('./config/env');
const requestLogger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');
const v1Routes = require('./routes/v1');
const blockchainSyncService = require('./services/blockchainSyncService');
const socketBroadcastService = require('./services/socketBroadcastService');
const simulatorManager = require('./services/simulatorManager');
const mqttIngestionService = require('./services/mqtt/mqttIngestionService');
const timeseriesSetup = require('./services/timeseries/timeseriesSetup');
const rollupWorker = require('./workers/rollupWorker');
const publicGridPoller = require('./workers/publicGridPoller');
const autoListingMatcher = require('./workers/autoListingMatcher');
const { isTimeseriesEnabled } = require('./config/timeseries');
const { initSocket } = require('./socket');

const startServer = async () => {
  validateEnvironment();
  await connectDB();

  const app = express();
  const PORT = process.env.PORT || 5000;
  const isProduction = process.env.NODE_ENV === 'production';

  // Use Node's simple querystring parser instead of qs so that
  // ?field[$ne]=value is NOT parsed into an object ({ field: { $ne: 'value' } }).
  // This blocks NoSQL operator-injection via the query string globally.
  app.set('query parser', 'simple');

  // Trust the first proxy hop so req.ip and X-Forwarded-* are honored behind
  // load balancers (Render, Vercel, nginx). 1 hop is appropriate for a single
  // reverse proxy layer; increase if multiple proxies are chained.
  app.set('trust proxy', 1);

  const server = http.createServer(app);
  initSocket(server, app);

  const parseCorsOrigins = () =>
    String(process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  const configuredOrigins = parseCorsOrigins();
  const corsOptions = {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (configuredOrigins.length === 0 && !isProduction) {
        return callback(null, true);
      }
      if (configuredOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS blocked for this origin'));
    },
    credentials: true,
  };

  app.use(cors(corsOptions));
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(requestLogger);

  app.get('/api/health', (req, res) => {
    // Intentionally minimal public probe for load balancers — no internal state exposed.
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/v1', v1Routes);

  app.get('/', (req, res) => {
    res.send('EcoPulse Backend API');
  });

  app.use((req, res, next) => {
    const error = new Error(`Not Found - ${req.originalUrl}`);
    res.status(404);
    next(error);
  });

  app.use(errorHandler);

  const startBackgroundSync = () => {
    const intervalMs = parseInt(process.env.BLOCKCHAIN_SYNC_INTERVAL_MS || '60000', 10);

    const runSync = async () => {
      try {
        await blockchainSyncService.syncBlockchainTrades();
        await socketBroadcastService.flushAnalytics('full');
      } catch (err) {
        console.warn('Background blockchain sync skipped:', err.message);
      }
    };

    setTimeout(runSync, 5000);
    setInterval(runSync, intervalMs);
  };

  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    // Abort requests that take longer than 30s (prevents slow-loris style DoS)
    server.requestTimeout = 30000;
    server.headersTimeout = 35000;
    startBackgroundSync();
    blockchainSyncService.listenToBlockchainEvents();
    // Start the embedded grid simulator when SIMULATOR_EMBEDDED=true.
    simulatorManager.startIfEnabled();
    // Start the MQTT ingestion service when MQTT_INGESTION_ENABLED=true.
    mqttIngestionService.start();

    // Sub-module 1.3 — bootstrap the time-series collection + indexes and
    // start the hourly rollup worker when TIMESERIES_ENABLED=true.
    if (isTimeseriesEnabled()) {
      timeseriesSetup.ensureAll().then((status) => {
        if (!status.ok) {
          console.error('[timeseries] setup failed:', status.error);
        } else {
          console.log('[timeseries] collection ready');
        }
      });
      rollupWorker.start();
    }

    // Sub-module 1.5.3 — start the public grid poller when
    // PUBLIC_GRID_INGESTION_ENABLED=true (and public APIs are an allowed source).
    publicGridPoller.start();

    // Sub-module 2.3.3 — start the auto-listing matcher when
    // AUTO_TRADING_ENABLED=true. The per-tick gate re-reads the admin kill
    // switch, so a runtime pause takes effect without a restart.
    autoListingMatcher.start();
  });
};

startServer().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});

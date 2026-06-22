require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const connectDB = require('./config/db');
const { disconnectDB } = require('./config/db');
const { validateEnvironment } = require('./config/env');
const { disconnectRedis } = require('./config/redis');
const correlationId = require('./middleware/correlationId');
const metricsMiddleware = require('./middleware/metricsMiddleware');
const { metricsHandler } = require('./routes/metrics');
const requestLogger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');
const { issueCsrfToken, csrfProtection } = require('./middleware/csrf');
const { getHealth } = require('./services/healthService');
const { logger } = require('./utils/logger');
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
const { initSocket, closeSocket } = require('./socket');

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '15000', 10);

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
    exposedHeaders: ['X-CSRF-Token'],
  };

  app.use(cors(corsOptions));
  app.use(compression());
  app.use(helmet({
    contentSecurityPolicy: isProduction ? undefined : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(issueCsrfToken);
  app.use(correlationId);
  app.use(metricsMiddleware);
  app.use(requestLogger);

  app.get('/api/health', (req, res) => {
    // Intentionally minimal public probe for load balancers — no internal state exposed.
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/health/ready', async (req, res, next) => {
    try {
      const health = await getHealth();
      const ready = health.overall !== 'down';
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        overall: health.overall,
        checkedAt: health.checkedAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/metrics', metricsHandler);

  app.use('/api/v1', csrfProtection, v1Routes);

  app.get('/', (req, res) => {
    res.send('EcoPulse Backend API');
  });

  app.use((req, res, next) => {
    const error = new Error(`Not Found - ${req.originalUrl}`);
    res.status(404);
    next(error);
  });

  app.use(errorHandler);

  let blockchainSyncBootstrapTimer = null;
  let blockchainSyncInterval = null;
  let shuttingDown = false;

  const stopBackgroundSync = () => {
    if (blockchainSyncBootstrapTimer) {
      clearTimeout(blockchainSyncBootstrapTimer);
      blockchainSyncBootstrapTimer = null;
    }
    if (blockchainSyncInterval) {
      clearInterval(blockchainSyncInterval);
      blockchainSyncInterval = null;
    }
  };

  const startBackgroundSync = () => {
    const intervalMs = parseInt(process.env.BLOCKCHAIN_SYNC_INTERVAL_MS || '60000', 10);

    const runSync = async () => {
      if (shuttingDown) return;
      try {
        await blockchainSyncService.syncBlockchainTrades();
        await socketBroadcastService.flushAnalytics('full');
      } catch (err) {
        logger.warn('background blockchain sync skipped', { err, component: 'blockchain-sync' });
      }
    };

    blockchainSyncBootstrapTimer = setTimeout(runSync, 5000);
    blockchainSyncInterval = setInterval(runSync, intervalMs);
  };

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown signal received', { signal, component: 'shutdown' });

    stopBackgroundSync();
    blockchainSyncService.stopListeningToBlockchainEvents();
    simulatorManager.stop();
    mqttIngestionService.stop();
    rollupWorker.stop();
    publicGridPoller.stop();
    autoListingMatcher.stop();

    const forceExitTimer = setTimeout(() => {
      logger.error('shutdown forced exit', { timeoutMs: SHUTDOWN_TIMEOUT_MS, component: 'shutdown' });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      await closeSocket();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await disconnectRedis();
      await disconnectDB();
      clearTimeout(forceExitTimer);
      logger.info('shutdown complete', { component: 'shutdown' });
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      logger.error('shutdown error', { err, component: 'shutdown' });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      logger.error('shutdown unhandled error', { err, component: 'shutdown' });
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      logger.error('shutdown unhandled error', { err, component: 'shutdown' });
      process.exit(1);
    });
  });

  server.listen(PORT, () => {
    logger.info('server listening', { port: PORT, component: 'server' });
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
          logger.error('timeseries setup failed', { err: status.error, component: 'timeseries' });
        } else {
          logger.info('timeseries collection ready', { component: 'timeseries' });
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
  logger.error('fatal startup error', { err });
  process.exit(1);
});

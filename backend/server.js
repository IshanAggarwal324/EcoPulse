require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const requestLogger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');
const v1Routes = require('./routes/v1');
const blockchainSyncService = require('./services/blockchainSyncService');
const socketBroadcastService = require('./services/socketBroadcastService');
const { initSocket } = require('./socket');

connectDB();

const app = express();
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
initSocket(server, app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

app.get('/api/health', (req, res) => {
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
  startBackgroundSync();
  blockchainSyncService.listenToBlockchainEvents();
});

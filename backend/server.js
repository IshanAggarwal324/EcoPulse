require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const requestLogger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');
const v1Routes = require('./routes/v1');
const EnergyReading = require('./models/EnergyReading');
const analyticsService = require('./services/analyticsService');
const blockchainSyncService = require('./services/blockchainSyncService');

connectDB();

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
});

app.set('io', io);

const broadcastAnalytics = async () => {
  try {
    const summary = await analyticsService.getSummary();
    io.emit('analyticsUpdate', summary);
  } catch (err) {
    console.error('Analytics broadcast failed:', err.message);
  }
};

io.on('connection', (socket) => {
  console.log('Socket client connected:', socket.id);

  socket.on('simulateReading', async (data) => {
    const reading = {
      nodeId: data.nodeId,
      energyGenerated: data.energyGenerated || 0,
      energyConsumed: data.energyConsumed || 0,
      timestamp: new Date().toISOString(),
    };

    if (mongoose.Types.ObjectId.isValid(data.nodeId)) {
      try {
        const saved = await EnergyReading.create({
          nodeId: data.nodeId,
          energyGenerated: reading.energyGenerated,
          energyConsumed: reading.energyConsumed,
        });
        const payload = saved.toObject();
        io.emit('newReading', payload);
        await broadcastAnalytics();
        return;
      } catch (err) {
        console.error('Socket reading persist failed:', err.message);
      }
    }

    io.emit('newReading', reading);
  });

  socket.on('disconnect', () => {
    console.log('Socket client disconnected:', socket.id);
  });
});

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
      await broadcastAnalytics();
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
  blockchainSyncService.listenToBlockchainEvents(io);
});

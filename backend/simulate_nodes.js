require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { SimulatorRunner } = require('./services/simulator');

const start = async () => {
  if (process.env.MONGO_URI && process.env.SIM_USE_DB_NODES !== 'false') {
    await connectDB();
  } else {
    console.warn('[Simulator] Running without MongoDB — built-in mock node profiles only.');
  }

  const runner = new SimulatorRunner({ transport: 'socket' });

  const shutdown = () => {
    runner.stop();
    if (mongoose.connection.readyState === 1) {
      mongoose.connection.close().finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await runner.start();
};

start().catch((err) => {
  console.error('Simulator failed:', err.message);
  process.exit(1);
});

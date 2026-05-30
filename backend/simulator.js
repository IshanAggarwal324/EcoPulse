require('dotenv').config();
const connectDB = require('./config/db');
const { SimulatorRunner } = require('./services/simulator');

const start = async () => {
  await connectDB();
  console.log('MongoDB connected for REST simulator');

  const runner = new SimulatorRunner({ transport: 'rest' });

  const shutdown = () => {
    runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await runner.start();
};

start().catch((err) => {
  console.error('Simulator failed:', err.message);
  process.exit(1);
});

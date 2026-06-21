const mongoose = require('mongoose');

const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!uri || uri.includes('<YOUR_MONGODB_ATLAS_CONNECTION_STRING>')) {
    const message = isProduction
      ? 'MONGO_URI must be configured in production'
      : 'MONGO_URI is not set. The database is required to start the server.';
    throw new Error(message);
  }

  const maxPoolSize = (() => {
    const parsed = parseInt(process.env.MONGO_MAX_POOL_SIZE || '50', 10);
    return Number.isFinite(parsed) && parsed >= 10 ? parsed : 50;
  })();

  const minPoolSize = (() => {
    const parsed = parseInt(process.env.MONGO_MIN_POOL_SIZE || '0', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  })();

  try {
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB runtime error:', err.message);
    });

    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize,
      minPoolSize,
      retryWrites: true,
    });
    console.log(`MongoDB Connected: ${conn.connection.host} (pool max=${maxPoolSize})`);
    return conn;
  } catch (error) {
    throw new Error(`Failed to connect to MongoDB: ${error.message}`);
  }
};

const disconnectDB = async () => {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  console.log('MongoDB disconnected');
};

module.exports = connectDB;
module.exports.disconnectDB = disconnectDB;

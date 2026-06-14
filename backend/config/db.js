const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI || process.env.MONGO_URI.includes('<YOUR_MONGODB_ATLAS_CONNECTION_STRING>')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('MONGO_URI must be configured in production');
      }
      console.warn('MongoDB connection skipped: MONGO_URI is not set in .env');
      return;
    }
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1); // Exit process with failure
  }
};

module.exports = connectDB;

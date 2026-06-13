#!/usr/bin/env node

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const mongoose = require('mongoose');
const User = require('../models/User');

const email = process.argv[2] || process.env.BOOTSTRAP_ADMIN_EMAIL;

async function main() {
  if (!email) {
    console.error('Usage: node scripts/promote-admin.js <email>');
    console.error('   or: set BOOTSTRAP_ADMIN_EMAIL in .env and run without arguments');
    process.exit(1);
  }

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Check your .env file.');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      console.error(`No user found with email: ${normalizedEmail}`);
      console.error('Create the user first via POST /api/v1/auth/register, then re-run this script.');
      process.exit(1);
    }

    if (user.role === 'admin') {
      console.log(`User ${normalizedEmail} is already an admin. No changes made.`);
      process.exit(0);
    }

    const previousRole = user.role;
    user.role = 'admin';
    await user.save();

    console.log(`User ${normalizedEmail} promoted from "${previousRole}" to "admin".`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

main();

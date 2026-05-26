const mongoose = require('mongoose');

const syncStateSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    default: 'energy_trading',
  },
  lastSyncedBlock: {
    type: Number,
    default: 0,
  },
  chainId: {
    type: Number,
  },
  contractAddress: {
    type: String,
    lowercase: true,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('SyncState', syncStateSchema);

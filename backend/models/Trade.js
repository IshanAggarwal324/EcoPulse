const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
  listingId: {
    type: Number,
    required: true,
  },
  eventType: {
    type: String,
    enum: ['listed', 'purchased'],
    required: true,
  },
  seller: {
    type: String,
    lowercase: true,
  },
  buyer: {
    type: String,
    lowercase: true,
  },
  energyAmount: {
    type: Number,
    default: 0,
  },
  price: {
    type: String,
    default: '0',
  },
  txHash: {
    type: String,
    unique: true,
    sparse: true,
  },
  blockNumber: {
    type: Number,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

tradeSchema.index({ eventType: 1, timestamp: -1 });
tradeSchema.index({ listingId: 1, eventType: 1 });

module.exports = mongoose.model('Trade', tradeSchema);

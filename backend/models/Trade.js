const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
  listingId: {
    type: Number,
    required: true,
  },
  eventType: {
    type: String,
    enum: ['listed', 'purchased', 'cancelled', 'expired'],
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
    required: true,
    lowercase: true,
  },
  logIndex: {
    type: Number,
    required: true,
  },
  blockNumber: {
    type: Number,
    required: true,
  },
  blockTimestamp: {
    type: Date,
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

tradeSchema.index({ txHash: 1, logIndex: 1 }, { unique: true });
tradeSchema.index({ eventType: 1, blockTimestamp: -1 });
tradeSchema.index({ listingId: 1, eventType: 1 });
tradeSchema.index({ listingId: 1, blockTimestamp: -1, blockNumber: -1 });
tradeSchema.index({ seller: 1, blockTimestamp: -1 });
tradeSchema.index({ buyer: 1, blockTimestamp: -1 });
tradeSchema.index({ blockNumber: -1 });

module.exports = mongoose.model('Trade', tradeSchema);

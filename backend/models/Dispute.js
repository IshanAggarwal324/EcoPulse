const mongoose = require('mongoose');

const DISPUTE_OUTCOMES = ['release', 'refund', 'split'];

const disputeSchema = new mongoose.Schema({
  disputeId: {
    type: Number,
    required: true,
    index: true,
  },
  escrowId: {
    type: Number,
    required: true,
    index: true,
  },
  buyer: {
    type: String,
    required: true,
    lowercase: true,
    index: true,
  },
  seller: {
    type: String,
    required: true,
    lowercase: true,
    index: true,
  },
  amount: {
    type: String, // raw token amount (wei)
    required: true,
  },
  evidenceHash: {
    type: String,
    default: null,
  },
  evidenceCid: {
    type: String, // off-chain human-readable evidence pointer
    default: null,
  },
  reason: {
    type: String,
    default: null,
    maxlength: 1000,
  },
  resolved: {
    type: Boolean,
    default: false,
    index: true,
  },
  outcome: {
    type: String,
    enum: DISPUTE_OUTCOMES,
    default: null,
  },
  buyerShareBps: {
    type: Number,
    default: null,
    min: 0,
    max: 10000,
  },
  resolvedBy: {
    type: String, // arbiter wallet address
    lowercase: true,
    default: null,
  },
  resolvedAt: {
    type: Date,
    default: null,
  },
  openedAt: {
    type: Date,
    index: true,
  },
  txHash: {
    type: String,
    lowercase: true,
    index: true,
  },
  blockNumber: {
    type: Number,
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

disputeSchema.index({ chainId: 1, contractAddress: 1, disputeId: 1 }, { unique: true });
disputeSchema.index({ resolved: 1, openedAt: -1 });

module.exports = mongoose.model('Dispute', disputeSchema);
module.exports.DISPUTE_OUTCOMES = DISPUTE_OUTCOMES;

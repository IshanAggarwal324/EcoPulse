const mongoose = require('mongoose');

const ESCROW_STATES = ['funded', 'delivered', 'released', 'disputed', 'refunded'];

const escrowSchema = new mongoose.Schema({
  escrowId: {
    type: Number,
    required: true,
    index: true,
  },
  listingId: {
    type: Number,
    default: null,
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
    type: String, // raw token amount (wei) — stored as string to keep precision
    required: true,
  },
  amountEther: {
    type: String, // human-readable CC amount
    default: null,
  },
  state: {
    type: String,
    enum: ESCROW_STATES,
    required: true,
    index: true,
  },
  createdAt: {
    type: Date, // on-chain block timestamp of creation
    index: true,
  },
  deliveredAt: {
    type: Date,
    default: null,
  },
  evidenceCid: {
    type: String,
    default: null,
  },
  disputeId: {
    type: Number,
    default: null,
  },
  // Latest transaction hash that advanced this escrow's state.
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

// One on-chain escrow per chain/contract/id. An escrow's state is overwritten
// by subsequent indexed events (Funded → Delivered → Released, etc.), so we key
// on (chainId, contractAddress, escrowId) rather than per-log.
escrowSchema.index({ chainId: 1, contractAddress: 1, escrowId: 1 }, { unique: true });
escrowSchema.index({ state: 1, createdAt: -1 });

module.exports = mongoose.model('Escrow', escrowSchema);
module.exports.ESCROW_STATES = ESCROW_STATES;

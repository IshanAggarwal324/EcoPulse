const mongoose = require('mongoose');

/**
 * Settlement — Module 5.2.4
 *
 * Single source of truth for the on-chain ⇄ off-chain settlement lifecycle of a
 * purchase. One record per (chainId, contractAddress, txHash, logIndex) so a
 * re-org re-scan never creates duplicates; verification + reconciliation both
 * upsert against that key.
 *
 * Lifecycle:
 *   pending → verified   (receipt matches on-chain listing)
 *   pending → mismatch   (reconciliation delta exceeds tolerance)
 *   any     → disputed   (auto-flagged when mismatch + high anomaly score)
 */
const VERIFICATION_STATUSES = ['pending', 'verified', 'mismatch', 'disputed'];

const MISMATCH_FLAGS = [
  'OVER_DELIVERY',
  'UNDER_DELIVERY',
  'READING_GAP',
  'RECEIPT_MISMATCH',
];

const settlementSchema = new mongoose.Schema(
  {
    chainId: { type: Number, required: true },
    contractAddress: { type: String, required: true, lowercase: true },
    txHash: { type: String, required: true, lowercase: true },
    logIndex: { type: Number, required: true },
    listingId: { type: Number, required: true },
    tradeRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Trade',
      default: null,
    },
    seller: { type: String, lowercase: true, default: null },
    buyer: { type: String, lowercase: true, default: null },
    onChainStatus: { type: String, default: null },
    // 5.2.2 receipt verification outcome.
    verificationStatus: {
      type: String,
      enum: VERIFICATION_STATUSES,
      default: 'pending',
      required: true,
    },
    onChainEnergy: { type: Number, default: null },
    onChainPrice: { type: String, default: null },
    offChainEnergy: { type: Number, default: null },
    deltaPct: { type: Number, default: null },
    mismatchFlags: {
      type: [String],
      enum: MISMATCH_FLAGS,
      default: [],
    },
    anomalyScore: { type: Number, default: null, min: 0, max: 1 },
    confirmations: { type: Number, default: null },
    blockNumber: { type: Number, default: null },
    // Structured evidence trail: receipt checks + reconciliation samples.
    evidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    verifiedAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    autoFlagged: { type: Boolean, default: false },
  },
  { timestamps: true },
);

settlementSchema.index(
  { chainId: 1, contractAddress: 1, txHash: 1, logIndex: 1 },
  { unique: true },
);
settlementSchema.index({ listingId: 1 });
settlementSchema.index({ seller: 1, createdAt: -1 });
settlementSchema.index({ buyer: 1, createdAt: -1 });
settlementSchema.index({ verificationStatus: 1, createdAt: -1 });
settlementSchema.index({ mismatchFlags: 1 });

settlementSchema.statics.VERIFICATION_STATUSES = VERIFICATION_STATUSES;
settlementSchema.statics.MISMATCH_FLAGS = MISMATCH_FLAGS;

module.exports = mongoose.model('Settlement', settlementSchema);

const mongoose = require('mongoose');

/**
 * CreditAward — Module 5.3.7 (mint-to-earn)
 *
 * Idempotent ledger of carbon-credit awards issued for verified green
 * generation. The `evidenceHash` makes every award one-shot: the same verified
 * reading window can never be paid out twice. Admin/system-initiated only.
 */
const AWARD_STATUSES = ['pending', 'awarded', 'failed'];

const creditAwardSchema = new mongoose.Schema(
  {
    chainId: { type: Number, required: true },
    contractAddress: { type: String, required: true, lowercase: true },
    recipient: { type: String, required: true, lowercase: true },
    nodeId: { type: String, default: null },
    kwh: { type: Number, required: true, min: 0 },
    windowStart: { type: Date, default: null },
    windowEnd: { type: Date, default: null },
    ccAmount: { type: String, required: true },
    ccAmountEther: { type: String, default: null },
    // keccak over (nodeId, windowStart, windowEnd, kwh) — idempotency key.
    evidenceHash: { type: String, required: true },
    txHash: { type: String, lowercase: true, default: null },
    status: { type: String, enum: AWARD_STATUSES, default: 'pending', required: true },
    failureReason: { type: String, default: null },
    awardedBy: { type: String, default: null },
    awardedAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

creditAwardSchema.index(
  { chainId: 1, contractAddress: 1, evidenceHash: 1 },
  { unique: true },
);
creditAwardSchema.index({ recipient: 1, createdAt: -1 });
creditAwardSchema.index({ nodeId: 1, windowEnd: -1 });
creditAwardSchema.index({ status: 1, createdAt: -1 });

creditAwardSchema.statics.AWARD_STATUSES = AWARD_STATUSES;

module.exports = mongoose.model('CreditAward', creditAwardSchema);

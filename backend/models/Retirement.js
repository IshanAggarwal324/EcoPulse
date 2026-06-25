const mongoose = require('mongoose');

/**
 * Retirement — Module 5.3.5
 *
 * Off-chain mirror of on-chain CarbonCredit `Retired` events, indexed from the
 * transaction receipt the client submits after retiring (the burn is signed by
 * the holder, so the backend holds no user keys). One record per
 * (chainId, contractAddress, retirementId) so re-indexing is idempotent.
 */
const retirementSchema = new mongoose.Schema(
  {
    chainId: { type: Number, required: true },
    contractAddress: { type: String, required: true, lowercase: true },
    retirementId: { type: Number, required: true },
    retiree: { type: String, required: true, lowercase: true },
    amount: { type: String, required: true },
    amountEther: { type: String, default: null },
    certificateUri: { type: String, default: '' },
    initiator: { type: String, lowercase: true, default: null },
    txHash: { type: String, required: true, lowercase: true },
    blockNumber: { type: Number, default: null },
    blockTimestamp: { type: Date, default: null },
    registryRecorded: { type: Boolean, default: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

retirementSchema.index(
  { chainId: 1, contractAddress: 1, retirementId: 1 },
  { unique: true },
);
retirementSchema.index({ retiree: 1, createdAt: -1 });
retirementSchema.index({ txHash: 1 });

module.exports = mongoose.model('Retirement', retirementSchema);

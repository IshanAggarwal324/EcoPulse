const mongoose = require('mongoose');

/**
 * BridgeTransfer — Module 5.3.4
 *
 * Idempotent mirror of CarbonCreditBridge events so a re-org re-scan never
 * creates duplicates and the backend can answer bridge-status queries without a
 * round-trip to the chain. One record per (chainId, contractAddress, direction,
 * nonce, logIndex).
 *
 * direction:
 *   lock    — outbound custody (Locked)
 *   mint    — inbound credit via relayer (Minted)
 *   return  — holder burned bridged CC (ReturnedToSource)
 *   release — relayer returned originally locked CC (Released)
 */
const DIRECTIONS = ['lock', 'mint', 'return', 'release'];
const STATUSES = ['pending', 'processed', 'failed'];

const bridgeTransferSchema = new mongoose.Schema(
  {
    chainId: { type: Number, required: true },
    contractAddress: { type: String, required: true, lowercase: true },
    direction: { type: String, enum: DIRECTIONS, required: true },
    // On-chain identifier as emitted: lockId / returnId / relayer nonce.
    nonce: { type: String, required: true },
    // Idempotency hash mirroring the contract's processedNonces key (mint/release).
    nonceHash: { type: String, default: null },
    sourceChainId: { type: Number, default: null },
    targetChainId: { type: Number, default: null },
    sender: { type: String, lowercase: true, default: null },
    recipient: { type: String, lowercase: true, default: null },
    relayer: { type: String, lowercase: true, default: null },
    amount: { type: String, required: true },
    amountEther: { type: String, default: null },
    status: { type: String, enum: STATUSES, default: 'processed', required: true },
    txHash: { type: String, required: true, lowercase: true },
    logIndex: { type: Number, required: true },
    blockNumber: { type: Number, default: null },
    blockTimestamp: { type: Date, default: null },
    evidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

bridgeTransferSchema.index(
  { chainId: 1, contractAddress: 1, direction: 1, nonce: 1, logIndex: 1 },
  { unique: true },
);
bridgeTransferSchema.index({ sender: 1, createdAt: -1 });
bridgeTransferSchema.index({ recipient: 1, createdAt: -1 });
bridgeTransferSchema.index({ sourceChainId: 1, createdAt: -1 });
bridgeTransferSchema.index({ targetChainId: 1, createdAt: -1 });
bridgeTransferSchema.index({ nonceHash: 1 }, { sparse: true });

bridgeTransferSchema.statics.DIRECTIONS = DIRECTIONS;
bridgeTransferSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('BridgeTransfer', bridgeTransferSchema);

const mongoose = require('mongoose');

/**
 * BuyOrder (Sub-module 6.1.3 — buy-side order book, off-chain).
 *
 * The EcoPulse marketplace is sell-listing based on-chain. To present a real,
 * two-sided order book we accept *off-chain signed* buy intents (the demand
 * side) that mirror the proven ListingIntent EIP-712 pattern. The backend
 * stores ONLY:
 *   - the signature (hex string)
 *   - the recovered signer wallet (verified server-side to equal the user's
 *     walletAddress)
 *   - the full typed-data payload (bounds auditable)
 *   - a per-user monotonic nonce (replay protection)
 *
 * It NEVER stores a private key, mnemonic, or signing material. The signature
 * proves the wallet owner committed to the buy bounds; a future relayer could
 * use it to fill against a matching sell listing. In v2 of this module the
 * intent is notify/aggregate only — it is not relayed on-chain.
 *
 * Lifecycle: active -> consumed | expired | cancelled. Expiry is enforced via
 * `expiresAt`; the matcher/depth layer ignores intents past expiry. Nonces are
 * monotonic per user so a captured signature cannot be replayed.
 */

const STATUS_VALUES = ['active', 'consumed', 'expired', 'cancelled'];

const buyOrderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Wallet that signed; verified to equal the user's walletAddress.
    signer: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    signature: {
      type: String,
      required: true,
    },
    // Full EIP-712 typed-data (domain + message) as signed by the wallet.
    typedData: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // Per-user monotonic nonce (replay protection). The next valid nonce for a
    // user must be strictly greater than the max stored nonce.
    nonce: {
      type: Number,
      required: true,
      min: 0,
    },
    // Authorized bounds (mirror of typedData.message for easy querying/indexing).
    maxEnergyKwh: {
      type: Number,
      required: true,
      min: 0,
    },
    // Max CC per kWh the bidder will pay.
    maxUnitPriceCc: {
      type: Number,
      required: true,
      min: 0,
      index: true,
    },
    // Max total CC the bidder will spend.
    maxTotalCc: {
      type: Number,
      required: true,
      min: 0,
    },
    chainId: {
      type: Number,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: STATUS_VALUES,
      default: 'active',
      index: true,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
    // Link to the on-chain listing + tx that filled this intent (v2 relayer).
    matchedListingId: {
      type: Number,
      default: null,
    },
    consumedTxHash: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    consumedChainId: {
      type: Number,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelledReason: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },
    // IP/UA of the create request, for audit attribution. select:false so it
    // never leaks into default API responses.
    sourceIp: {
      type: String,
      default: null,
      select: false,
    },
    sourceUserAgent: {
      type: String,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

buyOrderSchema.index({ userId: 1, nonce: -1 });
// Active demand scan for the order book / matcher: only live, unexpired bids.
buyOrderSchema.index({ status: 1, expiresAt: 1, maxUnitPriceCc: -1 });

buyOrderSchema.virtual('isExpired').get(function () {
  return this.expiresAt ? this.expiresAt.getTime() <= Date.now() : true;
});

buyOrderSchema.statics.STATUS_VALUES = STATUS_VALUES;

module.exports = mongoose.model('BuyOrder', buyOrderSchema);

const mongoose = require('mongoose');

/**
 * ListingIntent (Sub-module 2.3.4).
 *
 * Stores a user's EIP-712 *off-chain* signed listing intent created in the
 * frontend (MetaMask) at policy-enable time. The backend stores ONLY:
 *   - the signature (r,s,v hex string)
 *   - the recovered signer wallet address (verified server-side to equal the
 *     user's walletAddress)
 *   - the full typed-data payload (domain + message) so the bounds are auditable
 *   - a per-user nonce for replay protection
 *
 * It NEVER stores a private key, mnemonic, or any signing material. The
 * signature proves the wallet owner consented to the listed bounds; the matcher
 * respects those bounds. In v1 (notify-only) the signature is the consent proof
 * and is not relayed on-chain; in v2 an optional relayer could submit using it.
 *
 * Lifecycle: active -> consumed | expired | revoked. A TTL-ish expiry is
 * enforced via `expiresAt`; the matcher rejects intents past expiry. Nonces are
 * monotonic per user so a captured signature cannot be replayed.
 */

const STATUS_VALUES = ['active', 'consumed', 'expired', 'revoked'];

const listingIntentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    policyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AutoListingPolicy',
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
    // Kept so bounds + nonce are auditable without re-deriving them.
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
    // Authorized bounds (mirror of typedData.message for easy querying).
    maxEnergyKwh: {
      type: Number,
      required: true,
      min: 0,
    },
    minUnitPriceCc: {
      type: Number,
      min: 0,
      default: null,
    },
    maxUnitPriceCc: {
      type: Number,
      min: 0,
      default: null,
    },
    maxTotalCc: {
      type: Number,
      min: 0,
      default: null,
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
    // Post-list validation link (Sub-module 2.4.2): when the on-chain
    // EnergyListed event for the listing authorized by this intent is indexed,
    // the matcher/sync layer stamps the resulting listing id + tx here and
    // transitions status to 'consumed'. This closes the recommendation →
    // on-chain confirmation loop without the backend ever signing anything.
    consumedListingId: {
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
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedReason: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },
    // IP/UA of the enable request, for audit attribution. select:false so it
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

listingIntentSchema.index({ userId: 1, nonce: -1 });
listingIntentSchema.index({ policyId: 1, status: 1, expiresAt: 1 });
// Fast lookup for post-list validation: find an intent to link by its consumer.
listingIntentSchema.index({ signer: 1, status: 1, createdAt: -1 });
listingIntentSchema.index({ consumedTxHash: 1, consumedListingId: 1 });

listingIntentSchema.virtual('isExpired').get(function () {
  return this.expiresAt ? this.expiresAt.getTime() <= Date.now() : true;
});

listingIntentSchema.statics.STATUS_VALUES = STATUS_VALUES;

module.exports = mongoose.model('ListingIntent', listingIntentSchema);

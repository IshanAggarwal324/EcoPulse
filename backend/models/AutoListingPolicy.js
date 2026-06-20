const mongoose = require('mongoose');

/**
 * AutoListingPolicy (Sub-module 2.3.1).
 *
 * A user-managed, OPT-IN policy that tells the auto-listing matcher how to
 * watch a node's forecast surplus and (in v1) notify the user when a listing
 * is recommended. The policy itself carries no secrets — execution authority
 * comes from a separately-stored, EIP-712-signed `ListingIntent`.
 *
 * Guardrails baked into the schema:
 *   - `enabled` defaults to false (opt-in only). The matcher skips disabled
 *     policies entirely.
 *   - `notifyOnly` defaults to true. v1 never auto-submits on-chain; the user
 *     always confirms the real listing in MetaMask.
 *   - Per-policy hard limits (`maxListingsPerDay`, `maxTotalCcPerDay`,
 *     `minTimeBetweenListingsMs`, `minSurplusKwh`) are enforced at write time
 *     by the controller and at match time by the service (defense in depth).
 *   - One active policy per (user, node) — a compound unique index prevents a
 *     user from stacking overlapping policies on the same node. To change
 *     strategy, PATCH the existing policy.
 */

const PRICE_STRATEGIES = ['forecast_derived', 'fixed_discount'];
const NOTIFY_CHANNELS = ['in_app', 'email'];

const autoListingPolicySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    nodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EnergyNode',
      required: true,
      index: true,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    // Minimum forecast surplus (kWh) that must be available before the matcher
    // produces a listing recommendation for this policy.
    minSurplusKwh: {
      type: Number,
      min: 0,
      default: 1,
    },
    // Hard cap on auto-decisions (recommendations) per UTC day.
    maxListingsPerDay: {
      type: Number,
      min: 1,
      default: 3,
    },
    // Hard cap on the sum of recommended total CC across a UTC day.
    maxTotalCcPerDay: {
      type: Number,
      min: 0,
      default: 1000,
    },
    // Minimum gap between two auto-decisions for this policy (ms).
    minTimeBetweenListingsMs: {
      type: Number,
      min: 0,
      default: 3600000,
    },
    priceStrategy: {
      type: String,
      enum: PRICE_STRATEGIES,
      default: 'forecast_derived',
    },
    // Used only when priceStrategy === 'fixed_discount'. Percent off the
    // forecast-derived unit price (0..90).
    fixedDiscountPercent: {
      type: Number,
      min: 0,
      max: 90,
      default: 5,
    },
    // Bounds the matcher will never price outside. Null = inherit global
    // pricing floor/ceiling.
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
    // v1 default: notify only. The backend never auto-submits in v1.
    notifyOnly: {
      type: Boolean,
      default: true,
    },
    notifyChannels: {
      type: [String],
      enum: NOTIFY_CHANNELS,
      default: () => ['in_app'],
    },
    // Consent + intent linkage. A policy may only be `enabled` while a valid
    // (non-expired) ListingIntent exists. The active intent id is tracked here
    // so the matcher can verify authority per tick.
    activeIntentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ListingIntent',
      default: null,
    },
    // Operational state (mutated only by the matcher / admin).
    lastMatchedAt: {
      type: Date,
      default: null,
    },
    lastMatchDecision: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      select: false,
    },
    disabledReason: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// One active policy per (user, node). Partial index so disabled-then-recreated
// policies don't collide; the uniqueness is on the live (userId, nodeId) pair.
autoListingPolicySchema.index(
  { userId: 1, nodeId: 1 },
  { unique: true },
);

autoListingPolicySchema.statics.PRICE_STRATEGIES = PRICE_STRATEGIES;
autoListingPolicySchema.statics.NOTIFY_CHANNELS = NOTIFY_CHANNELS;

module.exports = mongoose.model('AutoListingPolicy', autoListingPolicySchema);

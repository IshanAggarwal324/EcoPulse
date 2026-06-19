const mongoose = require('mongoose');

/**
 * DeviceCredential
 *
 * Stores a hardware device's identity and authentication material for the
 * IoT ingestion path (Sub-module 1.1). Only a bcrypt HASH of the API key is
 * ever persisted — the plaintext key is returned exactly once at provisioning
 * time and is never logged, cached, or re-read by the backend.
 *
 * Security notes:
 *  - `apiKeyHash` is bcrypt-hashed (cost ~12). A plaintext key is unrecoverable.
 *  - `apiKeyVersion` is incremented on every rotation so revocation is immediate
 *    even if a previously-issued key somehow lingers in a device's memory.
 *  - `failedAuthAttempts` + `lockedUntil` persist lockout state so a restart of
 *    the backend (or a Redis outage) cannot reset an active brute-force defense.
 *    The Redis counter in deviceAuth.js is the fast path; this is the fallback.
 *  - `select: false` on sensitive fields keeps them out of default `find()`
 *    projections (anti-leak across admin UI / accidental serialization).
 */

const STATUS_VALUES = ['active', 'revoked', 'locked'];
const RATE_LIMIT_TIERS = ['standard', 'high', 'unrestricted'];

const deviceCredentialSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      // Stable public identifier carried in the `x-device-id` header.
      // e.g. "dev_3f9a2b1c8d7e4f60"
      match: [/^[a-zA-Z0-9_\-]{6,64}$/, 'deviceId must be 6-64 alphanumeric/underscore/hyphen characters'],
      index: true,
    },
    label: {
      type: String,
      trim: true,
      maxlength: [120, 'Label cannot exceed 120 characters'],
      default: null,
    },
    nodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EnergyNode',
      required: true,
      index: true,
    },
    apiKeyHash: {
      type: String,
      required: true,
      select: false,
    },
    apiKeyVersion: {
      type: Number,
      default: 1,
      min: 1,
    },
    mqttClientId: {
      type: String,
      trim: true,
      maxlength: [128, 'mqttClientId cannot exceed 128 characters'],
      default: null,
    },
    allowedTopics: {
      // Device may ONLY publish to topics derived from its bound nodeId.
      // Defaults to the canonical telemetry topic; admin may extend (e.g. status).
      type: [String],
      default: () => [],
    },
    rateLimitTier: {
      type: String,
      enum: RATE_LIMIT_TIERS,
      default: 'standard',
    },
    maxCapacityKw: {
      // Per-device ceiling used at ingestion to reject implausible telemetry
      // (guardrail 1.2.2). Null = inherit node-level capacity / no hard cap.
      type: Number,
      min: 0,
      default: null,
    },
    status: {
      type: String,
      enum: STATUS_VALUES,
      default: 'active',
      index: true,
    },
    lastSeenAt: {
      type: Date,
      default: null,
    },
    lastSeenIp: {
      type: String,
      default: null,
      select: false,
    },
    failedAuthAttempts: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },
    lastFailedAuthAt: {
      type: Date,
      default: null,
      select: false,
    },
    lockedUntil: {
      type: Date,
      default: null,
      select: false,
    },
    lastRotatedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedReason: {
      type: String,
      trim: true,
      maxlength: [255, 'revokedReason cannot exceed 255 characters'],
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

deviceCredentialSchema.index({ nodeId: 1, status: 1 });

deviceCredentialSchema.virtual('isLocked').get(function () {
  return !!(this.lockedUntil && this.lockedUntil > Date.now());
});

deviceCredentialSchema.statics.STATUS_VALUES = STATUS_VALUES;
deviceCredentialSchema.statics.RATE_LIMIT_TIERS = RATE_LIMIT_TIERS;

module.exports = mongoose.model('DeviceCredential', deviceCredentialSchema);

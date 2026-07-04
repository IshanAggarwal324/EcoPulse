const mongoose = require('mongoose');
const crypto = require('crypto');
const { DEFAULT_ROLE, ALL_ROLES } = require('../auth/roles');

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME_MS = 15 * 60 * 1000;
const EMAIL_VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [50, 'Name cannot exceed 50 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        'Please provide a valid email address',
      ],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    // Module 8.4 — wallet is now cryptographically linked via EIP-712
    // (/auth/wallet/challenge -> /auth/wallet/link). The address is the single
    // source of truth for carbon balances, settlements and trades, so it MUST
    // be unique across the platform and may only be set through the signed flow.
    // `unique + sparse` allows many users with `null` (unlinked) addresses while
    // rejecting any duplicate claim of the same address. See migration script
    // scripts/migrate-wallet-address-index.js to clean dupes before the index.
    walletAddress: {
      type: String,
      default: null,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      match: [/^0x[a-fA-F0-9]{40}$/, 'Wallet address must be a valid Ethereum address'],
    },
    // null until the user signs an EIP-712 challenge to bind the wallet. Legacy
    // manually-entered addresses remain but keep `walletLinkedAt: null`, which
    // the UI uses to prompt a re-link. Settlements/trades key off walletAddress
    // regardless, so this field is an attestation flag, not a gate.
    walletLinkedAt: {
      type: Date,
      default: null,
    },
    // Last-verified signature (audit only; never used to authorize anything).
    walletLinkSignature: {
      type: String,
      default: null,
      select: false,
    },
    // Pending single-use EIP-712 challenge. select:false so it never leaks in a
    // default projection; the wallet-link controller selects it explicitly.
    walletLinkChallenge: {
      nonce: { type: String, default: null },
      wallet: { type: String, default: null },
      issuedAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      _id: false,
    },
    // Module 8.3 — zone codes a grid_operator is responsible for. Grants
    // read-only visibility into EnergyNodes whose zoneId matches. Ignored for
    // every other role. Kept on the default projection so protect() loads it.
    assignedZoneIds: {
      type: [String],
      default: [],
    },
    role: {
      // Module 8.1 — domain personas (separate from node types). `user` is the
      // pre-8.1 legacy value; run scripts/migrate-user-roles.js to backfill.
      type: String,
      enum: ALL_ROLES,
      default: DEFAULT_ROLE,
    },
    preferences: {
      emailNotifications: { type: Boolean, default: true },
      gridAlerts: { type: Boolean, default: true },
      energyUnit: { type: String, enum: ['kWh', 'MWh'], default: 'kWh' },
    },
    isBanned: {
      type: Boolean,
      default: false,
    },
    bannedAt: {
      type: Date,
      default: null,
    },
    bannedReason: {
      type: String,
      default: null,
    },
    bannedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    loginAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
    lockUntil: {
      type: Date,
      default: null,
      select: false,
    },
    refreshTokenVersion: {
      type: Number,
      default: 0,
      select: false,
    },
    accessTokenVersion: {
      type: Number,
      default: 0,
      select: false,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
      select: false,
    },
    emailVerificationToken: {
      type: String,
      default: null,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      default: null,
      select: false,
    },
    emailVerificationLastSentAt: {
      type: Date,
      default: null,
      select: false,
    },
    mustChangePassword: {
      type: Boolean,
      default: false,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

userSchema.methods.incLoginAttempts = function () {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ $set: { loginAttempts: 1 }, $unset: { lockUntil: 1 } });
  }
  const updates = { $inc: { loginAttempts: 1 } };
  if (this.loginAttempts + 1 >= MAX_LOGIN_ATTEMPTS && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + LOCK_TIME_MS };
  }
  return this.updateOne(updates);
};

userSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({ $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } });
};

userSchema.statics.generateEmailVerificationToken = function () {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashed = crypto.createHash('sha256').update(rawToken).digest('hex');
  return {
    rawToken,
    hashed,
    expires: new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS),
  };
};

userSchema.statics.hashEmailVerificationToken = function (rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

userSchema.statics.EMAIL_VERIFICATION_EXPIRY_MS = EMAIL_VERIFICATION_EXPIRY_MS;

userSchema.index({ email: 1 });
userSchema.index({ isBanned: 1 });
userSchema.index({ role: 1 });
userSchema.index({ deletedAt: 1 });

module.exports = mongoose.model('User', userSchema);

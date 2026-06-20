const mongoose = require('mongoose');

/**
 * Notification (Sub-module 2.3.5 — in-app notification store).
 *
 * EcoPulse had no persisted notification surface before 2.3; the auto-listing
 * matcher requires durable, user-scoped notifications ("we found a listing
 * opportunity for node X") that survive reconnects and can be listed/dismissed.
 * This model backs that. Delivery is in-app (socket to the user's room) and
 * optionally email (via emailService), gated by the user's preferences.
 *
 * Notes:
 *   - `data` is arbitrary context (e.g. a recommendation snapshot). It is
 *     treated as untrusted and must never contain secrets/PII beyond what the
 *     owning user is already permitted to see.
 *   - TTL expires old notifications server-side so the table stays bounded.
 *   - No cross-user leakage: every query must filter by userId (enforced in
 *     the service/controller, never trusted from the client).
 */

const CHANNELS = ['in_app', 'email'];

const notificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      // Short stable code, e.g. 'auto_listing_recommendation', 'auto_listing_stale'.
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    channels: {
      type: [String],
      enum: CHANNELS,
      default: () => ['in_app'],
    },
    readAt: {
      type: Date,
      default: null,
    },
    dismissedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1, createdAt: -1 });

// Bounded retention: old notifications expire server-side.
const ttlDays = parseInt(process.env.NOTIFICATION_TTL_DAYS || '30', 10);
if (Number.isFinite(ttlDays) && ttlDays > 0) {
  notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 86400 });
}

notificationSchema.virtual('isRead').get(function () {
  return Boolean(this.readAt);
});

module.exports = mongoose.model('Notification', notificationSchema);

/**
 * Notification service (Sub-module 2.3.5).
 *
 * Delivers durable, user-scoped notifications. Each `send()`:
 *   1. persists a Notification row (survives reconnects, listable/dismissible),
 *   2. pushes it in real time to the user's socket room (`user:{id}`),
 *   3. optionally sends an email when 'email' is in channels AND the user has
 *      email notifications enabled in their preferences.
 *
 * Scoping: every read/mutation filters strictly by userId — a user can never
 * read or dismiss another user's notifications. The `data` payload must never
 * contain secrets/PII beyond what the owning user already sees.
 */

const Notification = require('../models/Notification');
const { SOCKET_EVENTS } = require('../socket/events');
const emailService = require('./emailService');
const { parsePagination, paginateResults } = require('../utils/paginate');

// Lazily resolve the socket server so requiring this module never pulls in the
// full socket/tokens stack at load time (keeps pure-logic tests importable).
const getIo = () => {
  try {
    return require('../socket').getIo();
  } catch {
    return null;
  }
};

const escapeHtml = (input) =>
  String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

/**
 * Send a notification. Resolves to the persisted doc (delivery channels are
 * best-effort: a socket/email failure never blocks the write).
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.type
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {object|null} opts.data
 * @param {string[]} opts.channels  subset of ['in_app','email']; default ['in_app']
 * @param {object|null} opts.user   optional lean User doc (for email preference check)
 */
async function send({ userId, type, title, body, data = null, channels = ['in_app'], user = null }) {
  const safeChannels = Array.isArray(channels) && channels.length > 0 ? channels : ['in_app'];

  const doc = await Notification.create({
    userId,
    type,
    title: String(title || '').slice(0, 200),
    body: String(body || '').slice(0, 2000),
    data: data ?? null,
    channels: safeChannels,
  });

  // In-app push: emit to the user's private room. Best-effort.
  try {
    const io = getIo();
    if (io) {
      io.to(`user:${String(userId)}`).emit(SOCKET_EVENTS.SERVER.NOTIFICATION, {
        id: String(doc._id),
        type: doc.type,
        title: doc.title,
        body: doc.body,
        data: doc.data,
        createdAt: doc.createdAt,
      });
    }
  } catch {
    // socket delivery is transient; the persisted row is the durable record.
  }

  if (safeChannels.includes('email')) {
    try {
      const check = emailService.canSendEmail(user || {});
      if (check.allowed && emailService.isConfigured()) {
        await emailService.sendEmail({
          to: user?.email,
          subject: title,
          html: `<div style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;">
            <h2 style="color:#2e7d32;">${escapeHtml(title)}</h2>
            <p>${escapeHtml(body)}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>
            <p style="font-size:12px;color:#888;">This is an EcoPulse notification. Manage your preferences in your account settings.</p>
          </div>`,
        });
      }
    } catch {
      // email is best-effort
    }
  }

  return doc;
}

async function list({ userId, type = null, unreadOnly = false, page = 1, limit = 25 } = {}) {
  const filter = { userId };
  if (type) filter.type = type;
  if (unreadOnly) filter.readAt = null;

  const { page: p, limit: l, skip } = parsePagination({ page, limit }, { maxLimit: 100 });

  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId, readAt: null }),
  ]);

  return {
    data: items,
    meta: { ...paginateResults({ page: p, limit: l, total }), unread },
  };
}

async function countUnread(userId) {
  return Notification.countDocuments({ userId, readAt: null });
}

async function markRead(notificationId, userId) {
  return Notification.findOneAndUpdate(
    { _id: notificationId, userId },
    { $set: { readAt: new Date() } },
    { new: true },
  ).lean();
}

async function markAllRead(userId) {
  const res = await Notification.updateMany(
    { userId, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return res?.modifiedN || 0;
}

async function dismiss(notificationId, userId) {
  return Notification.findOneAndUpdate(
    { _id: notificationId, userId },
    { $set: { dismissedAt: new Date(), readAt: new Date() } },
    { new: true },
  ).lean();
}

module.exports = {
  send,
  list,
  countUnread,
  markRead,
  markAllRead,
  dismiss,
};

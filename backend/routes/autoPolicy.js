const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const controller = require('../controllers/autoPolicyController');

/**
 * Auto-listing policy + intent + notification routes (Sub-module 2.3).
 *
 * Mounted under /api/v1/trading (which itself sits behind the v1 guardedUser
 * chain: protect + requirePasswordCurrent + requireEmailVerified). An
 * additional per-user rate limiter guards the signed-intent enable flow so a
 * compromised token cannot spam signature verifications.
 */

const policyLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: parseInt(process.env.AUTO_POLICY_RATE_LIMIT_MAX || '60', 10),
  message: 'Too many auto-trading requests. Please try again later.',
});

const enableLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: parseInt(process.env.AUTO_POLICY_ENABLE_RATE_LIMIT_MAX || '20', 10),
  message: 'Too many enable attempts. Please try again later.',
});

router.use(protect, policyLimiter);

// EIP-712 domain + intent bootstrap (before /:id so it isn't shadowed).
router.get('/auto-policy/eip712-domain', controller.getEip712Domain);

// Policy CRUD
router.route('/auto-policy')
  .get(controller.listPolicies)
  .post(controller.createPolicy);

router.route('/auto-policy/:id')
  .get(controller.getPolicy)
  .patch(controller.updatePolicy)
  .delete(controller.deletePolicy);

// Signed-intent enable / disable (opt-in flow)
router.post('/auto-policy/:id/enable', enableLimiter, controller.enablePolicy);
router.post('/auto-policy/:id/disable', controller.disablePolicy);

// Notifications (user-scoped)
router.get('/notifications', controller.listNotifications);
router.post('/notifications/:id/read', controller.markNotificationRead);
router.post('/notifications/read-all', controller.markAllNotificationsRead);
router.post('/notifications/:id/dismiss', controller.dismissNotification);

module.exports = router;

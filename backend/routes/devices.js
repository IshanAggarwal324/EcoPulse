const express = require('express');
const router = express.Router();
const { authorize } = require('../middleware/auth');
const { createAdminRateLimiter } = require('../middleware/rateLimit');
const controller = require('../controllers/admin/adminDeviceController');

// Sub-module 1.1 — Device Registry & Authentication (admin-only surface).
// These routes are mounted under /api/v1/admin which already enforces
// `authorize('admin','moderator')` + admin rate limit. `adminOnly` further
// restricts mutating actions to the `admin` role.
const adminOnly = authorize('admin');
router.use(createAdminRateLimiter());

// 1.1.2 — Provisioning API: list / create / get / update / delete
router.route('/')
  .get(controller.listDevices)
  .post(adminOnly, controller.createDevice);

router.route('/:id')
  .get(controller.getDevice)
  .patch(adminOnly, controller.updateDevice)
  .delete(adminOnly, controller.deleteDevice);

// 1.1.5 — Credential rotation & revocation
router.post('/:id/rotate-key', adminOnly, controller.rotateDeviceKey);
router.patch('/:id/revoke', adminOnly, controller.revokeDevice);

module.exports = router;

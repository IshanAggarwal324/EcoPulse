const express = require('express');
const router = express.Router();
const { authorize } = require('../middleware/auth');
const controller = require('../controllers/admin/adminPublicGridController');

/**
 * Sub-module 1.5.5 — Public Grid Source admin surface.
 *
 * Mounted under /api/v1/admin which already enforces
 * `authorize('admin','moderator')` + the admin rate limiter. `adminOnly`
 * further restricts every mutating action to the `admin` role.
 */
const adminOnly = authorize('admin');

router.get('/providers', controller.getProviders);
router.route('/')
  .get(controller.listSources)
  .post(adminOnly, controller.createSource);

router.route('/:id')
  .get(controller.getSource)
  .patch(adminOnly, controller.updateSource)
  .delete(adminOnly, controller.deleteSource);

router.post('/:id/poll-now', adminOnly, controller.pollNow);
router.post('/:id/reset-circuit', adminOnly, controller.resetCircuit);

module.exports = router;

/**
 * Module 8.3 — Grid zone admin routes.
 *
 * Mounted under /api/v1/admin/zones (admin-only). Zones are the unit of
 * grid_operator read scope; managing them and assigning them to operators is a
 * privileged platform operation.
 */
const express = require('express');
const router = express.Router();
const controller = require('../../controllers/admin/adminZoneController');

router.get('/', controller.listZones);
router.post('/', controller.createZone);
router.patch('/:code', controller.updateZone);
router.delete('/:code', controller.deleteZone);

module.exports = router;

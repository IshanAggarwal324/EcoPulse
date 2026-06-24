/**
 * Admin model lifecycle routes (Module 4.2.7).
 *
 * Mounted under /api/v1/admin/models with admin-only authorization. Promotion
 * (a mutation) additionally requires the strict admin role.
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../middleware/auth');
const controller = require('../../controllers/admin/adminModelController');

const adminOnly = authorize('admin');

router.get('/versions', controller.listModelVersions);
router.get('/compare', controller.compareModels);
router.get('/drift', controller.getDriftStatus);
router.post('/promote', adminOnly, controller.promoteModel);

module.exports = router;

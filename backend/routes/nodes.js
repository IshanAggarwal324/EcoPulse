const express = require('express');
const router = express.Router();
const {
  createNode,
  getNodes,
  getNodeById,
  updateNode,
  deleteNode,
  getNodesForMap,
} = require('../controllers/nodeController');
const { protect, authorize } = require('../middleware/auth');

// Module 9.5 — map payload. Registered before /:id so "map" is not treated as
// an ObjectId. Auth/rate-limit inherited from the guardedUser chain in v1.js.
router.get('/map', protect, getNodesForMap);

router.route('/')
  .post(protect, authorize('admin'), createNode)
  .get(protect, getNodes);

router.route('/:id')
  .get(protect, getNodeById)
  .put(protect, authorize('admin'), updateNode)
  .delete(protect, authorize('admin'), deleteNode);

module.exports = router;

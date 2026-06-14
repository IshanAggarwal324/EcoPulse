const express = require('express');
const router = express.Router();
const {
  createNode,
  getNodes,
  getNodeById,
  updateNode,
  deleteNode,
} = require('../controllers/nodeController');
const { protect, authorize } = require('../middleware/auth');

router.route('/')
  .post(protect, authorize('admin'), createNode)
  .get(protect, getNodes);

router.route('/:id')
  .get(protect, getNodeById)
  .put(protect, authorize('admin'), updateNode)
  .delete(protect, authorize('admin'), deleteNode);

module.exports = router;

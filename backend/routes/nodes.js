const express = require('express');
const router = express.Router();
const {
  createNode,
  getNodes,
  getNodeById,
  updateNode,
  deleteNode,
} = require('../controllers/nodeController');

router.route('/')
  .post(createNode)
  .get(getNodes);

router.route('/:id')
  .get(getNodeById)
  .put(updateNode)
  .delete(deleteNode);

module.exports = router;

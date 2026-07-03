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
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const P = require('../auth/permissions');

// Module 9.5 — map payload. Registered before /:id so "map" is not treated as
// an ObjectId. Auth/rate-limit inherited from the guardedUser chain in v1.js.
// (RBAC scoping happens inside buildMapFilter: own nodes only unless privileged.)
router.get('/map', protect, getNodesForMap);

router.route('/')
  // Module 8.2 — consumers/prosumers may create their own nodes; admins may
  // create on behalf of anyone. Ownership is forced in the controller for
  // non-privileged roles. grid_operator/moderator deliberately cannot create.
  .post(protect, requirePermission(P.NODES_CREATE), createNode)
  // Any authenticated role can list, but the result set is scoped in the
  // controller (own nodes for consumer/prosumer/grid_operator; all for admin).
  .get(protect, requirePermission(P.NODES_READ_OWN, P.NODES_READ_ZONE, P.NODES_READ_ALL), getNodes);

router.route('/:id')
  .get(protect, requirePermission(P.NODES_READ_OWN, P.NODES_READ_ZONE, P.NODES_READ_ALL), getNodeById)
  .put(protect, requirePermission(P.NODES_WRITE_OWN), updateNode)
  .delete(protect, requirePermission(P.NODES_DELETE_OWN), deleteNode);

module.exports = router;

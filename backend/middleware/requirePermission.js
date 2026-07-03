const { hasPermission } = require('../auth/roles');

/**
 * Module 8.2 — Capability-based route guard. Replaces ad-hoc
 * `authorize('admin')` strings with an explicit, auditable permission check.
 *
 * Usage:
 *   router.post('/', protect, requirePermission(P.NODES_CREATE), createNode);
 *   router.get('/', protect, requirePermission(P.NODES_READ_OWN, P.NODES_READ_ZONE), getNodes);
 *
 * Multiple arguments are OR-ed: access is granted if the caller's role holds
 * ANY of the listed permissions. Wildcard roles (admin) always pass.
 *
 * This middleware is the *coarse* gate. Resource-scoping (own/zone) is still
 * enforced in the controller/query layer — having `nodes:read:own` does not by
 * itself entitle a user to a node they do not own.
 *
 * @param {...string} permissions - one or more permission strings (OR-semantics)
 */
const requirePermission = (...permissions) => {
  if (!permissions.length) {
    throw new Error('requirePermission requires at least one permission string');
  }

  return (req, res, next) => {
    const role = req.user?.role;

    if (!role) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
        code: 'NOT_AUTHORIZED',
      });
    }

    const allowed = permissions.some((permission) => hasPermission(role, permission));

    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this action',
        code: 'FORBIDDEN',
      });
    }

    next();
  };
};

module.exports = { requirePermission };

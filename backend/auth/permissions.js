/**
 * Module 8.2 — Capability constants for the role-based access control map.
 *
 * Permissions are intentionally granular (`resource:action[:scope]`) so route
 * guards read as self-documenting policy. A role is granted a *set* of these in
 * `auth/roles.js`; `requirePermission()` checks membership.
 *
 * Scope suffixes:
 *   :own   -> the caller may touch only resources they own (ownership is still
 *             re-checked at the controller/query layer; the permission is the
 *             coarse gate).
 *   :zone  -> scoped to a grid_operator's assigned zone(s) (Module 8.3).
 *   :all   -> no data-scope restriction (platform-wide).
 */
module.exports = {
  NODES_CREATE: 'nodes:create',
  NODES_READ_OWN: 'nodes:read:own',
  NODES_READ_ZONE: 'nodes:read:zone',
  NODES_READ_ALL: 'nodes:read:all',
  NODES_WRITE_OWN: 'nodes:write:own',
  NODES_DELETE_OWN: 'nodes:delete:own',

  TRADES_EXECUTE: 'trades:execute',
  TRADES_READ_ALL: 'trades:read:all',

  CARBON_AWARD: 'carbon:award',
  CARBON_TRANSFER: 'carbon:transfer',

  ANALYTICS_READ_GLOBAL: 'analytics:read:global',
  ANALYTICS_READ_ZONE: 'analytics:read:zone',

  ADMIN_ACCESS: 'admin:access',
  USERS_MANAGE: 'users:manage',
  SYSTEM_SYNC: 'system:sync',
};

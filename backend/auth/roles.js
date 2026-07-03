const P = require('./permissions');

/**
 * Module 8.1 / 8.2 — Single source of truth for domain roles and the
 * role -> capability map.
 *
 * EcoPulse separates *app identity roles* (who the user is) from *node types*
 * (what hardware they run). A `consumer` may own consumer nodes; a `prosumer`
 * may own producer/consumer/prosumer nodes; a `grid_operator` is a regional
 * operator (read-only across an assigned zone, no user PII beyond ops needs).
 */

const ROLES = {
  CONSUMER: 'consumer',
  PROSUMER: 'prosumer',
  GRID_OPERATOR: 'grid_operator',
  ADMIN: 'admin',
  MODERATOR: 'moderator',
};

const ALL_ROLES = Object.values(ROLES);
const DEFAULT_ROLE = ROLES.CONSUMER;

/**
 * Legacy role mapping. The pre-8.1 enum was `user | admin | moderator`.
 * `user` collapses onto the new least-privileged persona (`consumer`); the
 * privileged roles are preserved verbatim. Used by the migration script and by
 * any defensive normalization path.
 */
const LEGACY_ROLE_MAP = { user: ROLES.CONSUMER };

function normalizeLegacyRole(role) {
  if (!role || typeof role !== 'string') return role;
  return LEGACY_ROLE_MAP[role] || role;
}

function isValidRole(role) {
  return typeof role === 'string' && ALL_ROLES.includes(role);
}

/**
 * Platform roles that are permitted to see *other users'* data (admin console,
 * global analytics, all nodes). Today that is admin + moderator (unchanged from
 * the pre-8.1 behaviour). `grid_operator` is intentionally NOT privileged — its
 * visibility is zone-scoped (Module 8.3) rather than global.
 */
const PRIVILEGED_ROLES = new Set([ROLES.ADMIN, ROLES.MODERATOR]);
const isPrivilegedRole = (role) => PRIVILEGED_ROLES.has(role);

/**
 * Role -> capability set.
 *
 * `'*'` is the wildcard: the role implicitly holds *every* permission
 * (superuser). This keeps the admin escape hatch in one place and means a new
 * permission is automatically granted to admins without editing this map.
 *
 * Unknown roles resolve to NO permissions (fail-closed) rather than falling
 * back to a broad default.
 */
const ROLE_PERMISSIONS = {
  [ROLES.CONSUMER]: [
    P.NODES_CREATE,
    P.NODES_READ_OWN,
    P.NODES_WRITE_OWN,
    P.NODES_DELETE_OWN,
    P.TRADES_EXECUTE,
    P.CARBON_TRANSFER,
  ],
  [ROLES.PROSUMER]: [
    P.NODES_CREATE,
    P.NODES_READ_OWN,
    P.NODES_WRITE_OWN,
    P.NODES_DELETE_OWN,
    P.TRADES_EXECUTE,
    P.CARBON_TRANSFER,
  ],
  [ROLES.GRID_OPERATOR]: [
    // Operators read their zone (Module 8.3); they may also own monitoring
    // nodes of their own. They deliberately cannot create/mutate nodes or
    // execute trades, and see no global analytics.
    P.NODES_READ_OWN,
    P.NODES_READ_ZONE,
    P.ANALYTICS_READ_ZONE,
  ],
  [ROLES.MODERATOR]: [
    P.NODES_READ_ALL,
    P.TRADES_READ_ALL,
    P.ANALYTICS_READ_GLOBAL,
    P.ADMIN_ACCESS,
    P.USERS_MANAGE,
  ],
  [ROLES.ADMIN]: '*',
};

/**
 * Resolve a role to its concrete permission list.
 * @returns {string[]|null} the permissions array, or `null` for the wildcard
 *   (meaning "all permissions"). An unknown/missing role yields `[]`.
 */
function rolePermissions(role) {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return [];
  if (perms === '*') return null;
  return perms;
}

/**
 * Does `role` grant `permission`? Wildcard roles always pass. Unknown roles
 * always fail (fail-closed).
 */
function hasPermission(role, permission) {
  if (!permission) return false;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms === '*') return true;
  return perms.includes(permission);
}

module.exports = {
  ROLES,
  ALL_ROLES,
  DEFAULT_ROLE,
  LEGACY_ROLE_MAP,
  normalizeLegacyRole,
  isValidRole,
  PRIVILEGED_ROLES,
  isPrivilegedRole,
  ROLE_PERMISSIONS,
  rolePermissions,
  hasPermission,
};

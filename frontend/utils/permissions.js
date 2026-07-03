/**
 * Module 8.2 (frontend) — client-side mirror of the backend role/permission map.
 *
 * This is for UI gating ONLY (showing/hiding nav items, buttons). Every real
 * authorization decision is enforced server-side via requirePermission(). A
 * client that tampers with these helpers gains nothing — the API still rejects
 * unauthorized calls.
 */

export const ROLES = {
  CONSUMER: 'consumer',
  PROSUMER: 'prosumer',
  GRID_OPERATOR: 'grid_operator',
  ADMIN: 'admin',
  MODERATOR: 'moderator',
};

export const DEFAULT_ROLE = ROLES.CONSUMER;

export const ALL_ROLES = Object.values(ROLES);

export const ROLE_LABELS = {
  [ROLES.CONSUMER]: 'Consumer',
  [ROLES.PROSUMER]: 'Prosumer',
  [ROLES.GRID_OPERATOR]: 'Grid Operator',
  [ROLES.ADMIN]: 'Admin',
  [ROLES.MODERATOR]: 'Moderator',
};

const PRIVILEGED_ROLES = new Set([ROLES.ADMIN, ROLES.MODERATOR]);

// '*' = wildcard (all permissions). Keep in sync with backend/auth/roles.js.
const ROLE_PERMISSIONS = {
  [ROLES.CONSUMER]: [
    'nodes:create', 'nodes:read:own', 'nodes:write:own', 'nodes:delete:own',
    'trades:execute', 'carbon:transfer',
  ],
  [ROLES.PROSUMER]: [
    'nodes:create', 'nodes:read:own', 'nodes:write:own', 'nodes:delete:own',
    'trades:execute', 'carbon:transfer',
  ],
  [ROLES.GRID_OPERATOR]: ['nodes:read:own', 'nodes:read:zone', 'analytics:read:zone'],
  [ROLES.MODERATOR]: [
    'nodes:read:all', 'trades:read:all', 'analytics:read:global',
    'admin:access', 'users:manage',
  ],
  [ROLES.ADMIN]: '*',
};

export const isAdmin = (user) => !!user && user.role === ROLES.ADMIN;
export const isPrivileged = (user) => !!user && PRIVILEGED_ROLES.has(user.role);
export const hasRole = (user, role) => !!user && user.role === role;

export const hasPermission = (user, permission) => {
  if (!user || !permission) return false;
  const perms = ROLE_PERMISSIONS[user.role];
  if (!perms) return false;
  if (perms === '*') return true;
  return perms.includes(permission);
};

// Convenience: returns true if the user holds ANY of the given permissions.
export const hasAnyPermission = (user, ...permissions) =>
  permissions.some((p) => hasPermission(user, p));

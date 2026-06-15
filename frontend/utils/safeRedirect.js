/**
 * Returns a safe in-app path for post-login redirects.
 * Blocks open redirects (external URLs, protocol-relative paths, etc.).
 */
export const getSafeRedirectPath = (pathname, fallback = '/') => {
  if (typeof pathname !== 'string' || !pathname) return fallback;

  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    return fallback;
  }

  if (pathname.includes('://') || pathname.includes('\\')) {
    return fallback;
  }

  return pathname;
};

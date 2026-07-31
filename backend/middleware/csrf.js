const crypto = require('crypto');
const ApiError = require('../utils/apiError');

const CSRF_COOKIE = 'csrfToken';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isProduction = process.env.NODE_ENV === 'production';
const csrfSameSite = isProduction ? 'none' : 'lax';

const getCookieValue = (cookieHeader, key) => {
  if (!cookieHeader) return null;
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(key.length + 1));
};

const usesCookieAuth = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) return false;
  return Boolean(getCookieValue(req.headers.cookie, 'accessToken'));
};

// Exempt routes are matched as ANCHORED path suffixes, never as substrings.
// `path.includes(prefix)` previously let any future route containing one of
// these strings (e.g. `/admin/telemetry-settings`) silently inherit a CSRF
// exemption.
const CSRF_EXEMPT_PREFIXES = [
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/captcha-config',
  '/telemetry',
];

const normalizePath = (value) => {
  const path = String(value || '/');
  // Strip a single trailing slash so `/telemetry/` matches `/telemetry`.
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
};

const isCsrfExempt = (req) => {
  const path = normalizePath(req.baseUrl ? `${req.baseUrl}${req.path}` : req.path);
  return CSRF_EXEMPT_PREFIXES.some(
    // Each entry starts with '/', which anchors the LEFT boundary to a path
    // segment ('/device-telemetry' can never match '/telemetry'). The RIGHT
    // boundary is either end-of-path or a '/', which anchors the other side
    // ('/telemetry-settings' can never match either).
    (prefix) => path.endsWith(prefix) || path.includes(`${prefix}/`)
  );
};

const issueCsrfToken = (req, res, next) => {
  let token = getCookieValue(req.headers.cookie, CSRF_COOKIE);
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: isProduction,
      sameSite: csrfSameSite,
      path: '/',
      maxAge: 24 * 60 * 60 * 1000,
    });
  }
  // Expose the token to cross-origin SPA clients that cannot read API-domain cookies.
  if (typeof res.setHeader === 'function') {
    res.setHeader('X-CSRF-Token', token);
  } else if (typeof res.set === 'function') {
    res.set('X-CSRF-Token', token);
  }
  next();
};

const csrfProtection = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!usesCookieAuth(req)) return next();
  if (isCsrfExempt(req)) return next();

  const cookieToken = getCookieValue(req.headers.cookie, CSRF_COOKIE);
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return next(new ApiError('Invalid or missing CSRF token', 403, 'CSRF_INVALID'));
  }
  return next();
};

module.exports = {
  CSRF_COOKIE,
  CSRF_HEADER,
  issueCsrfToken,
  csrfProtection,
  // exported for testing
  isCsrfExempt,
  CSRF_EXEMPT_PREFIXES,
};

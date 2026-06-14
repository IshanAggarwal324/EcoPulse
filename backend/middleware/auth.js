const User = require('../models/User');
const { verifyAccessToken } = require('../utils/tokens');

const getCookieValue = (cookieHeader, key) => {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((part) => part.trim());
  const entry = parts.find((part) => part.startsWith(`${key}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(key.length + 1));
};

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else {
    token = getCookieValue(req.headers.cookie, 'accessToken');
  }

  if (token) {
    try {
      const decoded = verifyAccessToken(token);

      if (decoded.type && decoded.type !== 'access') {
        return res.status(401).json({
          success: false,
          message: 'Invalid token type. Use an access token.',
          code: 'INVALID_TOKEN_TYPE',
        });
      }

      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Not authorized, user not found',
        });
      }

      if (req.user.deletedAt) {
        return res.status(401).json({
          success: false,
          message: 'This account has been deactivated',
          code: 'ACCOUNT_DEACTIVATED',
        });
      }

      if (req.user.isBanned) {
        return res.status(403).json({
          success: false,
          message: 'This account has been banned',
          code: 'ACCOUNT_BANNED',
        });
      }

      return next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Access token expired',
          code: 'TOKEN_EXPIRED',
        });
      }

      return res.status(401).json({
        success: false,
        message: 'Not authorized, token invalid',
        code: 'TOKEN_INVALID',
      });
    }
  }

  return res.status(401).json({
    success: false,
    message: 'Not authorized, no token',
    code: 'NO_TOKEN',
  });
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'You do not have permission to perform this action',
    });
  }
  next();
};

module.exports = { protect, authorize };

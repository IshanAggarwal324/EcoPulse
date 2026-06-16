const jwt = require('jsonwebtoken');

const ACCESS_EXPIRE = process.env.JWT_ACCESS_EXPIRE || '15m';
const REFRESH_EXPIRE = process.env.JWT_REFRESH_EXPIRE || '7d';
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

if (!ACCESS_SECRET) {
  throw new Error('JWT_ACCESS_SECRET or JWT_SECRET must be set');
}

if (!REFRESH_SECRET) {
  throw new Error('JWT_REFRESH_SECRET or JWT_SECRET must be set');
}

if (process.env.NODE_ENV === 'production' && ACCESS_SECRET === REFRESH_SECRET) {
  throw new Error('JWT access and refresh secrets must be different in production');
}

const generateAccessToken = (id, version = 0) =>
  jwt.sign({ id, type: 'access', version }, ACCESS_SECRET, {
    expiresIn: ACCESS_EXPIRE,
  });

const generateRefreshToken = (id, version = 0) =>
  jwt.sign({ id, type: 'refresh', version }, REFRESH_SECRET, {
    expiresIn: REFRESH_EXPIRE,
  });

const generateTokenPair = (id, refreshVersion = 0, accessVersion = 0) => ({
  accessToken: generateAccessToken(id, accessVersion),
  refreshToken: generateRefreshToken(id, refreshVersion),
});

const verifyRefreshToken = (token) => {
  const decoded = jwt.verify(token, REFRESH_SECRET);
  if (decoded.type !== 'refresh') {
    throw new Error('Invalid refresh token type');
  }
  return decoded;
};

const verifyAccessToken = (token) => {
  const decoded = jwt.verify(token, ACCESS_SECRET);
  if (decoded.type && decoded.type !== 'access') {
    throw new Error('Invalid access token type');
  }
  return decoded;
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  verifyRefreshToken,
  verifyAccessToken,
};

const jwt = require('jsonwebtoken');

const ACCESS_EXPIRE = process.env.JWT_ACCESS_EXPIRE || '15m';
const REFRESH_EXPIRE = process.env.JWT_REFRESH_EXPIRE || '7d';

const generateAccessToken = (id) =>
  jwt.sign({ id, type: 'access' }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_EXPIRE,
  });

const generateRefreshToken = (id) =>
  jwt.sign({ id, type: 'refresh' }, process.env.JWT_SECRET, {
    expiresIn: REFRESH_EXPIRE,
  });

const generateTokenPair = (id) => ({
  accessToken: generateAccessToken(id),
  refreshToken: generateRefreshToken(id),
});

const verifyRefreshToken = (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.type !== 'refresh') {
    throw new Error('Invalid refresh token type');
  }
  return decoded;
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  verifyRefreshToken,
};

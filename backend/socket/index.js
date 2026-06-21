const { Server } = require('socket.io');
const User = require('../models/User');
const { getSocketServerOptions } = require('../config/socket');
const registerHandlers = require('./registerHandlers');
const socketBroadcastService = require('../services/socketBroadcastService');
const { verifyAccessToken } = require('../utils/tokens');

const USER_AUTH_CACHE_TTL_MS = parseInt(process.env.SOCKET_USER_CACHE_TTL_MS || '60000', 10);
const userAuthCache = new Map();

let io = null;

const getCookieValue = (cookieHeader, key) => {
  if (!cookieHeader) return null;
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(key.length + 1));
};

const loadSocketUser = async (decoded) => {
  const cacheKey = `${decoded.id}:${decoded.version ?? 0}`;
  const hit = userAuthCache.get(cacheKey);
  if (hit && Date.now() - hit.at < USER_AUTH_CACHE_TTL_MS) {
    return hit.user;
  }

  const user = await User.findById(decoded.id).select('-password +accessTokenVersion');
  if (user && !user.deletedAt && !user.isBanned) {
    userAuthCache.set(cacheKey, { at: Date.now(), user });
  }
  return user;
};

const initSocket = (httpServer, app) => {
  io = new Server(httpServer, getSocketServerOptions());
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || getCookieValue(socket.handshake.headers.cookie, 'accessToken');
      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = verifyAccessToken(token);
      if (decoded.type && decoded.type !== 'access') {
        return next(new Error('Invalid token type'));
      }

      const user = await loadSocketUser(decoded);
      if (!user) {
        return next(new Error('Not authorized'));
      }

      if ((decoded.version ?? 0) !== (user.accessTokenVersion ?? 0)) {
        return next(new Error('Token revoked'));
      }

      socket.user = user;
      return next();
    } catch {
      return next(new Error('Authentication failed'));
    }
  });
  app.set('io', io);
  socketBroadcastService.setIo(io);
  registerHandlers(io);
  return io;
};

const getIo = () => io;

const closeSocket = () => new Promise((resolve) => {
  if (!io) {
    resolve();
    return;
  }

  io.close(() => {
    io = null;
    resolve();
  });
});

module.exports = { initSocket, getIo, closeSocket };

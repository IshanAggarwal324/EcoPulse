const { Server } = require('socket.io');
const { getSocketServerOptions } = require('../config/socket');
const registerHandlers = require('./registerHandlers');
const socketBroadcastService = require('../services/socketBroadcastService');

let io = null;

const initSocket = (httpServer, app) => {
  io = new Server(httpServer, getSocketServerOptions());
  app.set('io', io);
  socketBroadcastService.setIo(io);
  registerHandlers(io);
  return io;
};

const getIo = () => io;

module.exports = { initSocket, getIo };

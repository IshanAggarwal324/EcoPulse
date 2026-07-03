const simulateReadingHandler = require('./handlers/simulateReading');

// Module 9.6 — settlement lifecycle events are scoped to a user's linked wallet
// room (`wallet:<addr>`). Normalize to lowercase so it matches the Settlement
// model's seller/buyer storage and the broadcast service's emit target.
const walletRoom = (addr) =>
  typeof addr === 'string' && addr ? `wallet:${addr.trim().toLowerCase()}` : null;

const registerHandlers = (io) => {
  io.on('connection', (socket) => {
    if (socket.user?._id) {
      socket.join('authenticated');
      socket.join(`user:${socket.user._id.toString()}`);
      socket.join(`role:${socket.user.role}`);

      // Module 9.6 — join the wallet room so scoped settlement notifications
      // reach the buyer/seller of a trade. No-op when no wallet is linked.
      const wallet = walletRoom(socket.user.walletAddress);
      if (wallet) socket.join(wallet);
    }

    console.log('Socket client connected:', socket.id);
    simulateReadingHandler.register(socket);

    socket.on('disconnect', () => {
      console.log('Socket client disconnected:', socket.id);
    });
  });
};

module.exports = registerHandlers;

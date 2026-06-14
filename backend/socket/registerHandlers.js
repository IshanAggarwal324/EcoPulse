const simulateReadingHandler = require('./handlers/simulateReading');

const registerHandlers = (io) => {
  io.on('connection', (socket) => {
    if (socket.user?._id) {
      socket.join('authenticated');
      socket.join(`user:${socket.user._id.toString()}`);
      socket.join(`role:${socket.user.role}`);
    }

    console.log('Socket client connected:', socket.id);
    simulateReadingHandler.register(socket);

    socket.on('disconnect', () => {
      console.log('Socket client disconnected:', socket.id);
    });
  });
};

module.exports = registerHandlers;

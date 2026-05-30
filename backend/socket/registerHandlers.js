const simulateReadingHandler = require('./handlers/simulateReading');

const registerHandlers = (io) => {
  io.on('connection', (socket) => {
    console.log('Socket client connected:', socket.id);
    simulateReadingHandler.register(socket);

    socket.on('disconnect', () => {
      console.log('Socket client disconnected:', socket.id);
    });
  });
};

module.exports = registerHandlers;

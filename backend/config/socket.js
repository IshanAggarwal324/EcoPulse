const parseCorsOrigin = () => {
  const configured = process.env.SOCKET_CORS_ORIGIN || process.env.FRONTEND_URL;
  if (configured) {
    if (configured.includes(',')) {
      return configured.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return configured;
  }
  return process.env.NODE_ENV === 'production' ? false : '*';
};

const getSocketServerOptions = () => ({
  cors: {
    origin: parseCorsOrigin(),
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL_MS || '25000', 10),
  pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT_MS || '20000', 10),
});

module.exports = { getSocketServerOptions };

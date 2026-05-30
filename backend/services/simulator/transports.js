const http = require('http');
const { io } = require('socket.io-client');
const { SOCKET_EVENTS } = require('../../socket/events');

const createRestTransport = (baseUrl) => {
  const url = new URL(baseUrl.endsWith('/readings') ? baseUrl : `${baseUrl}/api/v1/readings`);

  return {
    name: 'rest',
    async send(reading) {
      const payload = JSON.stringify({
        nodeId: reading.nodeId,
        energyGenerated: reading.energyGenerated,
        energyConsumed: reading.energyConsumed,
      });

      return new Promise((resolve, reject) => {
        const options = {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true, status: res.statusCode, body: data });
            } else {
              reject(new Error(`REST ${res.statusCode}: ${data}`));
            }
          });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    },
  };
};

const createSocketTransport = (socketUrl) => {
  const socket = io(socketUrl, {
    transports: ['websocket', 'polling'],
    reconnection: true,
  });

  return {
    name: 'socket',
    socket,
    waitForConnect() {
      return new Promise((resolve, reject) => {
        if (socket.connected) {
          resolve();
          return;
        }
        const onError = (err) => {
          socket.off('connect', onConnect);
          reject(err);
        };
        const onConnect = () => {
          socket.off('connect_error', onError);
          resolve();
        };
        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
      });
    },
    send(reading) {
      if (!socket.connected) {
        return Promise.reject(new Error('Socket not connected'));
      }
      socket.emit(SOCKET_EVENTS.CLIENT.SIMULATE_READING, {
        nodeId: reading.nodeId,
        energyGenerated: reading.energyGenerated,
        energyConsumed: reading.energyConsumed,
      });
      return Promise.resolve({ ok: true });
    },
    close() {
      socket.disconnect();
    },
  };
};

module.exports = { createRestTransport, createSocketTransport };

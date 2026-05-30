require('dotenv').config();
const { io } = require('socket.io-client');
const { SOCKET_EVENTS } = require('./socket/events');

const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:5000';
const NODE_IDS = ['node_solar_01', 'node_wind_02', 'node_consumer_03'];

const socket = io(SOCKET_URL);

socket.on('connect', () => {
  console.log(`Simulator connected to ${SOCKET_URL}`);
  console.log('Sending mock readings every 3 seconds... Press Ctrl+C to stop.\n');

  setInterval(() => {
    const nodeId = NODE_IDS[Math.floor(Math.random() * NODE_IDS.length)];
    const isConsumer = nodeId.includes('consumer');

    const payload = {
      nodeId,
      energyGenerated: isConsumer ? 0 : Math.floor(Math.random() * 50) + 10,
      energyConsumed: isConsumer ? Math.floor(Math.random() * 30) + 5 : Math.floor(Math.random() * 5),
    };

    socket.emit(SOCKET_EVENTS.CLIENT.SIMULATE_READING, payload);
    console.log(`[Sent] Node: ${nodeId} | Gen: +${payload.energyGenerated}kW | Con: -${payload.energyConsumed}kW`);
  }, 3000);
});

socket.on('connect_error', (err) => {
  console.error('Connection failed:', err.message);
});

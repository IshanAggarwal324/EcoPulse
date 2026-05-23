require('dotenv').config();
const mongoose = require('mongoose');
const EnergyNode = require('./models/EnergyNode');
const http = require('http');

// MongoDB Connection
const connectDB = async () => {
  try {
    // Attempting to use either MONGO_URI or MONGODB_URI
    const dbUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!dbUri) {
      throw new Error('Please define MONGO_URI in your .env file');
    }
    await mongoose.connect(dbUri);
    console.log('MongoDB Connected for Simulator');
  } catch (err) {
    console.error('Database connection failed', err.message);
    process.exit(1);
  }
};

const runSimulator = async () => {
  console.log('Starting Energy Simulator...');
  
  // Find all existing nodes
  const nodes = await EnergyNode.find();
  if (nodes.length === 0) {
    console.log('No Energy Nodes found in the database. Please create some nodes first.');
    process.exit(0);
  }

  console.log(`Found ${nodes.length} nodes. Simulating readings every 10 seconds...`);

  setInterval(async () => {
    try {
      for (const node of nodes) {
        let energyGenerated = 0;
        let energyConsumed = 0;

        // Simple mock logic based on node type
        if (node.nodeType === 'producer' || node.nodeType === 'prosumer') {
          energyGenerated = Math.random() * 50; // Random generation 0-50
        }
        
        if (node.nodeType === 'consumer' || node.nodeType === 'prosumer') {
          energyConsumed = Math.random() * 30; // Random consumption 0-30
        }

        const payload = JSON.stringify({
          nodeId: node._id,
          energyGenerated: parseFloat(energyGenerated.toFixed(2)),
          energyConsumed: parseFloat(energyConsumed.toFixed(2)),
        });

        const options = {
          hostname: 'localhost',
          port: process.env.PORT || 5000,
          path: '/api/v1/readings',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 201) {
              const reading = JSON.parse(data).data;
              console.log(`[${new Date().toISOString()}] Created reading via API for node ${node.name}: +${reading.energyGenerated} / -${reading.energyConsumed}`);
            } else {
              console.error(`Failed to create reading: ${res.statusCode} ${data}`);
            }
          });
        });

        req.on('error', (e) => {
          console.error(`Problem with request: ${e.message}`);
        });

        req.write(payload);
        req.end();
      }
    } catch (err) {
      console.error('Error generating readings:', err.message);
    }
  }, 10000); // Run every 10 seconds
};

const start = async () => {
  await connectDB();
  await runSimulator();
};

start();

# EcoPulse Platform Overview

## What is EcoPulse?

EcoPulse is a decentralized smart energy grid and carbon credit marketplace. It enables peer-to-peer renewable energy trading using blockchain smart contracts and AI-powered energy forecasting. The platform simulates a smart energy grid where users can monitor real-time energy generation and consumption, forecast future energy demand using machine learning, trade surplus renewable energy with other users, earn blockchain-based carbon credits, and visualize grid activity through a modern dashboard.

EcoPulse is built on a MERN stack (MongoDB, Express, React, Node.js) with two Python FastAPI microservices: an AI service for LSTM-based energy forecasting on port 8000 and a GenAI service for the AI assistant and report narration on port 8001. Blockchain operations use Solidity smart contracts deployed via Hardhat, with support for local development and the Sepolia testnet.

## What is the energy grid?

The energy grid in EcoPulse is a simulated network of energy nodes that generate and consume electricity. Each node has a type (producer, consumer, or prosumer) and a source (solar, wind, home, industry, or other). Nodes produce or consume energy according to realistic diurnal patterns: solar panels peak around midday and produce nothing at night, wind turbines have variable output with gusts, homes peak in morning and evening, and industrial facilities peak during weekday business hours.

Energy readings are recorded every few seconds and stored in MongoDB. The grid's total generation, consumption, and net balance update in real time on the dashboard. Each reading contains the amount of energy generated and consumed in kilowatt-hours (kWh), along with a timestamp and a reference to the node.

## What are energy nodes?

Energy nodes are the building blocks of the grid. Each node represents a physical or simulated energy asset such as a solar farm, wind turbine, residential home, or industrial plant. Nodes have the following properties:

- **Name**: A descriptive label (e.g., "Riverside Solar", "Coastal Wind")
- **Node type**: `producer` (generates more than it consumes), `consumer` (consumes more than it generates), or `prosumer` (both generates and consumes significantly)
- **Source type**: `solar`, `wind`, `home`, `industry`, or `other`
- **Status**: `active`, `inactive`, or `maintenance`
- **Location**: An optional geographic description

When a node is inactive it reports zero output. When under maintenance it produces about 2% of its capacity and consumes 15% of its baseline. Users can create, view, update, and delete nodes through the `/nodes` API endpoints.

## How does energy monitoring work?

Energy monitoring in EcoPulse uses a simulator engine that generates realistic energy readings for all active nodes. The simulator applies diurnal curves with realistic patterns: solar irradiance follows a Gaussian curve peaking at 13:00 with cloud cover noise, wind output uses sine waves with gusts, home consumption has morning and evening peaks, and industrial consumption peaks on weekday afternoons.

Readings are sent via WebSocket or REST API every 5 seconds with slight randomness for realism. Each reading is stored in MongoDB and broadcast to all connected clients in real time via Socket.IO. The dashboard shows live readings, total generation and consumption, and node status panels that update automatically.

## How does trading work?

Energy trading on EcoPulse is fully on-chain through the EnergyTrading smart contract. Users list surplus energy for sale at a price denominated in Carbon Credit (CC) tokens. Other users can browse the marketplace and purchase listed energy.

The trading flow is:

1. **List energy**: The seller calls `listEnergy(energyAmount, price)` on the smart contract. The price is in CC tokens. The listing appears in the marketplace with status Active.
2. **Purchase**: The buyer first approves the EnergyTrading contract to spend their CC tokens, then calls `purchaseEnergy(listingId)`. The contract transfers CC from buyer to seller using `safeTransferFrom`. The listing status changes to Sold.
3. **Cancel**: The seller can cancel an active listing by calling `cancelListing(listingId)`, which changes the status to Cancelled.

All trades are recorded as blockchain events (`EnergyListed`, `EnergyPurchased`, `ListingCancelled`) that are synced to MongoDB for fast querying and analytics. The frontend shows an order book with sorting options, purchase and cancel buttons, and a transaction history with filters.

A MetaMask wallet connection is required for all trading actions. The platform includes a dev tool to mint 100 CC tokens for testing on local networks.

## What are carbon credits?

Carbon Credits (CC) are ERC-20 tokens on the blockchain that serve as the settlement currency for energy trades. Each CC token has 18 decimal places and the symbol "CC". They are minted by the contract owner and can be freely transferred between wallets.

Carbon credits represent the environmental value of renewable energy traded on the platform. When you sell energy, you receive CC tokens from the buyer. When you purchase energy, you pay in CC tokens. The platform tracks your credit flow: credits received from sales, credits spent on purchases, and your net flow (received minus spent). You can view your balance, transfer CC to other wallets, and see your transaction history on the Credits page.

## How does AI forecasting work?

EcoPulse uses an LSTM (Long Short-Term Memory) neural network to forecast energy generation and consumption for up to 90 days ahead. The model is trained on historical energy readings aggregated to daily totals.

The forecasting pipeline works as follows:

1. Historical energy readings are loaded from MongoDB and aggregated to daily generation and consumption values.
2. The data is normalized using MinMaxScaler and formatted into supervised learning windows with a configurable look-back period (default 30 days).
3. The LSTM model uses two LSTM layers (50 units each) with dropout regularization and a dense output layer predicting generation and consumption.
4. For multi-step forecasting, the model predicts one day at a time and rolls the prediction forward, appending each result to the input window.
5. Predictions include confidence bands that narrow for near-term forecasts and widen for longer horizons.

If the LSTM model is unavailable, the system falls back to heuristic predictions based on recent moving averages with a linear trend. Forecasts can be viewed for the entire network, a single node, or as a comparison across all nodes on the Forecasts page.

## How do I connect my wallet?

EcoPulse uses MetaMask for wallet integration. Connect your MetaMask browser extension on the Dashboard or Trading page. The platform validates that you are on the correct blockchain network (configured per deployment) and will prompt you to switch networks if needed.

Once connected, your wallet address is linked to your EcoPulse account and you can view your CC token balance, trade energy, transfer credits, and see your personal trading history and profit. If you disconnect, you can still view platform-wide analytics and grid data but will not see personal profit or wallet-specific information.

## Is the data real or simulated?

EcoPulse uses simulated energy data by default. The simulator generates realistic energy readings with diurnal patterns, weather effects, and noise to model a real energy grid. The data is designed for demonstration and development purposes.

When the system detects demo data (fewer than 30 readings in a non-production environment), it displays a disclaimer: "Based on simulated demo data." This disclaimer appears in AI-generated reports and chat responses. All numeric values shown are from actual computed metrics, not invented by the AI.

## What can the AI assistant do?

The EcoPulse AI assistant is a chat interface accessible from any authenticated page. It can answer questions about your energy data, grid statistics, trading activity, carbon credits, forecasts, and platform features. The assistant uses a hybrid retrieval system to provide accurate, grounded answers:

- **Structured retrieval**: For questions about energy, profit, trades, or forecasts, the system fetches real data from MongoDB analytics before generating a response. This ensures all numbers cited are accurate and come from actual platform data.
- **Document retrieval**: For general platform questions (how things work, what features are available), the assistant searches curated documentation to provide authoritative answers.

Source citations appear as chips under each response, showing where the data came from (e.g., "Grid energy totals (7d)", "Wallet flow history", or a document name).

## How do I generate a report?

Click the "Generate Report" button in the AI assistant to open the report wizard. The wizard has three steps:

1. **Period**: Choose 7 days, 14 days (fortnightly), or 30 days (monthly).
2. **Scope**: Choose personal wallet activity, full grid data, or both.
3. **Delivery**: Choose to receive the report as a summary in chat or as a detailed PDF sent to your registered email.

The report includes sections for personal energy (if wallet connected), grid energy totals, grid trading volume, node overview, and optionally a forecast outlook. All numbers in the report come from pre-computed analytics, not from the AI model.

## What are the platform pages?

EcoPulse has six main pages accessible via the sidebar:

- **Dashboard**: Real-time grid overview with energy totals, active nodes, live readings, and wallet connection.
- **Trading**: Marketplace order book, create/purchase/cancel orders, transaction history with filters.
- **Carbon Transactions**: Send CC tokens, view credit activity ledger, see balance and flow.
- **Forecasts**: 7-day AI predictions for energy generation and consumption with confidence bands. View aggregate, single node, or compare all nodes.
- **Credits**: Wallet balance, credits received/spent/net flow, platform-wide credit metrics, credit flow chart.
- **Settings**: Profile management, grid preferences (notifications, alerts, energy unit), password change, sign out.

## What technologies does EcoPulse use?

EcoPulse is built with the following technology stack:

- **Frontend**: React.js with Vite, Tailwind CSS, shadcn/ui, Recharts for charts, Socket.IO client for real-time updates, ethers.js for blockchain interaction
- **Backend**: Node.js with Express.js, MongoDB with Mongoose, Socket.IO for WebSocket communication, ethers.js v6 for blockchain operations
- **AI Service**: Python with FastAPI, TensorFlow/Keras for LSTM forecasting, Motor for async MongoDB access, Pandas and NumPy for data processing
- **GenAI Service**: Python with FastAPI, Google Gemini for natural language generation, template-based fallbacks when Gemini is unavailable
- **Blockchain**: Solidity smart contracts compiled with Hardhat, deployed on local Hardhat node or Sepolia testnet. OpenZeppelin libraries for secure token and marketplace implementations
- **Database**: MongoDB storing users, energy nodes, energy readings, trade events, and sync state

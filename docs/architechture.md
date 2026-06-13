# 🏗️ System Architecture

## Overview

The Smart Energy Grid & Carbon Credit Marketplace follows a modular distributed architecture combining:

- MERN Stack
- AI/ML Microservice
- Blockchain Smart Contracts
- Real-time communication

The system is designed to simulate decentralized renewable energy trading between multiple users.

---

# High-Level Architecture

```text
 ┌────────────────────┐
 │   React Frontend   │
 └─────────┬──────────┘
           │ REST APIs + WebSocket
           ▼
 ┌────────────────────┐
 │ Node.js Backend    │
 │ Express + SocketIO │
 └───┬─────┬────┬─────┘
     │     │    │
     │     │    │
     ▼     ▼    ▼
┌────────┐ ┌──────────────┐  ┌────────────────┐
│MongoDB │ │ FastAPI      │  │ FastAPI        │
│Database│ │ AI Service   │  │ GenAI Service  │
└────────┘ │ (LSTM)       │  │ (Gemini)       │
           │ Port 8000    │  │ Port 8001      │
           └──────┬───────┘  └───┬────────────┘
                  │               │
                  ▼               ▼
           ┌──────────┐   ┌──────────────┐
           │ LSTM     │   │ Gemini LLM   │
           │ Model    │   │ + Doc RAG    │
           └──────────┘   └──────────────┘

     Backend ↔ Blockchain

          ┌──────────────┐
          │ Solidity     │
          │ Contracts    │
          └──────────────┘
```

---

# Frontend Architecture

## Responsibilities
- Dashboard visualization
- Real-time energy monitoring
- Trading interface
- Forecast visualization
- Wallet integration

## Technologies
- React.js
- Tailwind CSS
- shadcn/ui
- Recharts
- Socket.io Client

---

# Backend Architecture

## Responsibilities
- Authentication
- API management
- Database communication
- Blockchain interaction
- Real-time updates

## Technologies
- Node.js
- Express.js
- MongoDB
- Socket.io
- ethers.js

---

# AI Service Architecture

## Responsibilities
- Data preprocessing
- Energy forecasting
- AI model inference
- Prediction APIs

## Technologies
- Python
- FastAPI
- TensorFlow
- Pandas
- NumPy

---

# Gen AI Service Architecture

## Responsibilities
- Natural language chat assistant (Energy Assistant)
- Report narration from structured metrics
- Document RAG over platform docs (FAQ)
- Hybrid retrieval: structured analytics + doc chunks

## Technologies
- Python
- FastAPI
- Google Gemini (`google-generativeai`)
- NumPy (cosine similarity for doc RAG)

## Service separation

| Service | Port | Responsibility |
|---------|------|----------------|
| `ai_service` | 8000 | LSTM energy forecasting only |
| `genai-service` | 8001 | Gemini chat, report narration, doc RAG |

## Key flows

### Chat Q&A
1. User sends message via frontend chat widget
2. Backend classifies intent (grid, wallet, carbon, forecast, FAQ)
3. Backend fetches relevant analytics from MongoDB
4. Payload sent to genai-service `/assistant/chat`
5. Gemini responds with grounded answer + sources

### Report generation
1. User picks period/scope/delivery in Report Wizard
2. Backend assembles metrics via `reportService`
3. Metrics sent to genai-service `/reports/narrate`
4. Gemini produces narrative summary + highlights
5. If email delivery: PDF generated and emailed; else shown in chat

---

# Blockchain Architecture

## Responsibilities
- Energy trading
- Carbon credit tokenization
- Transaction verification
- Smart contract execution

## Technologies
- Solidity
- Hardhat
- OpenZeppelin
- ethers.js

---

# Data Flow

## Energy Monitoring Flow

1. Energy simulator generates readings
2. Backend receives readings
3. Data stored in MongoDB
4. WebSocket updates frontend
5. AI service generates forecasts

---

## Trading Flow

1. User creates sell order
2. Smart contract validates transaction
3. Blockchain executes trade
4. Carbon credits minted
5. Frontend updates trade status

---

# Planned Microservices

## Frontend
- Dashboard UI
- Trading UI
- Forecast UI

## Backend
- Auth Service
- Energy Service
- Trading Service
- Blockchain Service

## AI Service
- Forecasting
- Preprocessing
- Prediction API

## Gen AI Service
- Energy Assistant chat
- Report narration
- Document RAG (FAQ)
- Hybrid retrieval

## Blockchain
- EnergyTrade.sol
- CarbonCredit.sol

---

# Scalability Goals

The project is designed with modularity in mind so that future features can be added without major restructuring.

Possible future expansions:
- IoT integration
- Weather API integration
- Mobile app
- Federated learning
- Advanced analytics
- Multi-region grid simulation
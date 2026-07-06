# EcoPulse — Complete Project Guide

> A deep, single-file explanation of what the EcoPulse project is, what lives
> where, how every subsystem works, and how all the pieces connect.
>
> This document is generated from a full read-through of the repository. It is
> intended as the one reference an engineer needs to understand the whole system
> end-to-end before diving into a specific component.

---

## Table of Contents

1. [What is EcoPulse?](#1-what-is-ecopulse)
2. [System Architecture at a Glance](#2-system-architecture-at-a-glance)
3. [Repository Layout](#3-repository-layout)
4. [Technology Stack](#4-technology-stack)
5. [Smart Contracts Layer (Solidity / Hardhat)](#5-smart-contracts-layer-solidity--hardhat)
6. [Backend Service (Node.js / Express)](#6-backend-service-nodejs--express)
7. [AI Forecasting Service (Python / FastAPI)](#7-ai-forecasting-service-python--fastapi)
8. [GenAI Service (Python / FastAPI + Gemini)](#8-genai-service-python--fastapi--gemini)
9. [Frontend (React + Vite)](#9-frontend-react--vite)
10. [Datastores](#10-datastores)
11. [How Everything Connects (End-to-End Flows)](#11-how-everything-connects-end-to-end-flows)
12. [Energy Ingestion Pipeline](#12-energy-ingestion-pipeline)
13. [AI Forecasting & Pricing](#13-ai-forecasting--pricing)
14. [Energy Marketplace & Trading](#14-energy-marketplace--trading)
15. [Escrow, Settlement & Dispute Resolution](#15-escrow-settlement--dispute-resolution)
16. [Carbon Credit Lifecycle (Mint → Trade → Retire → Bridge)](#16-carbon-credit-lifecycle-mint--trade--retire--bridge)
17. [Real-Time Layer (Socket.io)](#17-real-time-layer-socketio)
18. [Authentication, RBAC & Security Model](#18-authentication-rbac--security-model)
19. [Background Workers](#19-background-workers)
20. [Observability (Metrics, Logging, Health)](#20-observability-metrics-logging-health)
21. [Deployment & DevOps](#21-deployment--devops)
22. [Testing Strategy](#22-testing-strategy)
23. [Glossary](#23-glossary)

---

## 1. What is EcoPulse?

EcoPulse is a **smart energy grid platform** combined with a **carbon-credit
marketplace**. In one sentence: it lets energy **producers** (solar/battery
prosumers) and **consumers** trade surplus energy peer-to-peer, settle those
trades on an Ethereum blockchain using a fungible carbon-credit token, forecast
future generation/consumption with machine learning, and explore everything
through an LLM-powered assistant.

The product surface has five big pillars:

| Pillar | What it does |
|--------|--------------|
| **Energy monitoring & ingestion** | Devices (meters, inverters) push telemetry via MQTT or HTTP; the platform also simulates nodes and pulls from public grid APIs. |
| **AI forecasting** | An LSTM neural network predicts future generation/consumption per node, with confidence bands and an Isolation-Forest anomaly detector. |
| **P2P energy marketplace** | Users list energy for sale priced in CarbonCredits; buyers purchase (full or partial fills); prices follow an AI-informed pricing engine. |
| **Carbon-credit token economy** | A capped ERC-20 token (`CC`) is minted to reward green generation, traded for energy, retired (burned) to offset carbon, and bridged cross-chain. |
| **GenAI assistant & reports** | A Gemini-powered chatbot answers user questions grounded in live platform data, and narrates PDF/energy reports in plain English. |

The codebase is explicitly flagged as **demo/pilot-grade, not audited for
mainnet production** — every contract and the README carry an `AUDIT REQUIRED`
notice, and mainnet deployment is hard-blocked in `hardhat.config.js` until an
audit acknowledgement env var is set.

---

## 2. System Architecture at a Glance

EcoPulse is a **polyglot monorepo** of **four independently deployable
services** plus a **React frontend**, all coordinated around a shared MongoDB
database and an Ethereum (Sepolia testnet / local Hardhat) blockchain.

```
                       ┌──────────────────────────────────────────┐
                       │                 Browser                  │
                       │   React + Vite SPA (ecopulse/ + frontend/)│
                       └───────────────┬───────────┬──────────────┘
                            HTTPS REST │           │ WebSocket (Socket.io)
                                       ▼           ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                     BACKEND (Node.js / Express :5000)                │
   │                                                                     │
   │  REST API  •  Socket.io  •  MQTT ingestion  •  Blockchain sync      │
   │  Marketplace  •  Auth/RBAC  •  Workers  •  PDF reports              │
   └────┬───────────────┬─────────────────┬───────────────┬──────────────┘
        │ HTTP          │ HTTP            │ ethers.js RPC │
        ▼               ▼                 ▼               ▼
  ┌──────────┐   ┌──────────────┐   ┌────────────┐   ┌─────────────────┐
  │ MongoDB  │   │  Redis       │   │ Ethereum   │   │  External       │
  │ (state)  │   │  (cache/rate │   │ Sepolia /  │   │  MQTT broker /  │
  │          │   │   limiter)   │   │  Hardhat   │   │  Public grid    │
  └────▲─────┘   └──────────────┘   └────────────┘   └─────────────────┘
       │ reads/writes
       │
  ┌────┴───────────────────┐         ┌──────────────────────────────┐
  │  AI SERVICE (:8000)    │◄────────│  GENAI SERVICE (:8001)       │
  │  FastAPI + TensorFlow  │  (genai │  FastAPI + Google Gemini     │
  │  LSTM forecast +       │   may   │  Chat assistant + report     │
  │  IsolationForest       │  proxy) │  narration + Doc-RAG         │
  └────────────────────────┘         └──────────────────────────────┘
```

**Communication styles:**

- **Browser ⇄ Backend:** REST (`/api/v1/*`) + Socket.io for live updates.
- **Backend ⇄ AI/GenAI services:** server-to-server HTTP with a shared
  `INTERNAL_SERVICE_API_KEY` header (`x-internal-api-key`). The backend is the
  only public entry point; the Python services reject any non-health request
  that lacks the key.
- **Backend ⇄ Blockchain:** `ethers.js` over JSON-RPC (read via a provider,
  write via a deployer `Wallet` wrapped in a `NonceManager`).
- **Backend ⇄ Mongo/Redis:** Mongoose (Mongo) and ioredis (Redis, optional).
- **Backend ⇄ Devices:** MQTT subscriber (`ecopulse/nodes/+/telemetry`) and an
  HTTP push endpoint (`/api/v1/telemetry`) authenticated by device credentials.

---

## 3. Repository Layout

```
EcoPulse/
├── contracts/                 # Solidity smart contracts (the on-chain layer)
│   ├── CarbonCredit.sol       # ERC-20 carbon-credit token (capped, mintable, burnable)
│   ├── EnergyTrading.sol      # P2P energy marketplace (list / buy / partial fill)
│   ├── EnergyEscrow.sol       # Conditional settlement escrow
│   ├── DisputeResolution.sol  # Arbiter-ruled dispute resolution
│   ├── RetirementRegistry.sol # On-chain retirement ledger + provenance
│   ├── CarbonCreditBridge.sol # Lock/mint cross-chain bridge
│   ├── interfaces/            # IERC-style interfaces (breaks circular deps)
│   └── AUDIT_MANIFEST.json    # Audit status tracker (mainnet gate)
│
├── ignition/modules/          # Hardhat Ignition deploy module (EnergySystem.js)
├── test/                      # Smart-contract tests (Chai + hardhat-toolbox)
├── scripts/                   # Pre-deploy safety checks
│
├── backend/                   # Node.js / Express API (the orchestrator)
│   ├── server.js              # App entrypoint — wiring + lifecycle
│   ├── routes/                # Express routers (v1 aggregator + feature routers)
│   ├── controllers/           # Request handlers (one per resource)
│   ├── services/              # Business logic (marketplace, blockchain, ingest, …)
│   ├── models/                # Mongoose schemas (User, Trade, Settlement, …)
│   ├── middleware/            # auth, rate-limit, csrf, logging, metrics, …
│   ├── workers/               # Background schedulers (rollup, reconcile, …)
│   ├── socket/                # Socket.io server + event handlers
│   ├── auth/                  # Role + permission definitions (RBAC)
│   ├── config/                # env validation, db, redis, service URLs, …
│   ├── constants/             # Bundled contract ABIs (fallback if artifacts missing)
│   └── tests/                 # Node:test unit/integration suites
│
├── ai_service/                # Python / FastAPI — LSTM forecasting
│   ├── main.py                # Uvicorn entrypoint → app.factory.create_app
│   ├── app/                   # FastAPI app (routers, services, middleware, config)
│   ├── models/                # Keras LSTM + scikit-learn IsolationForest
│   ├── utils/                 # DB access, preprocessing, helpers
│   ├── jobs/                  # Retrain scheduler
│   └── tests/                 # unittest suite
│
├── genai-service/             # Python / FastAPI — Gemini LLM assistant
│   ├── main.py                # Uvicorn entrypoint
│   ├── app/                   # routers (assistant, reports, health, metrics)
│   ├── chatbot/  report-generation/   # (reserved/legacy dirs, currently empty)
│   └── tests/                 # unittest suite
│
├── ecopulse/                  # React + Vite FRONTEND APP (the host/bundler)
│   ├── src/App.jsx            # Route tree (lazy-loaded pages)
│   ├── src/main.jsx           # React DOM root
│   └── vite.config.js         # Vite build config (resolves ../../frontend)
│
├── frontend/                  # SHARED frontend code (imported by ecopulse/)
│   ├── pages/                 # Route-level screens (Dashboard, Trading, admin/*, …)
│   ├── components/            # Reusable UI (AppLayout, WalletConnect, charts, …)
│   ├── context/               # React providers (Auth, Socket, Wallet, Toast)
│   ├── hooks/                 # Data hooks (realtime, forecast, settlement, …)
│   ├── utils/                 # api client, socket client, blockchain helpers
│   └── constants/             # shared frontend constants
│
├── shared/                    # Cross-service contracts (health schema, python lib)
├── docs/                      # Internal engineering docs + assistant knowledge base
├── .github/workflows/         # CI (ci.yml), security, deploy, model retrain
├── docker-compose.yml         # Production-parity local stack
├── hardhat.config.js          # Solidity 0.8.28 + Sepolia + mainnet gate
├── package.json               # Root: contract tooling + workspace scripts
├── SECURITY.md                # Security policy & remediation status
├── P2P_Trading_Production_Readiness.md
├── production_time.md
└── SYSTEM_TESTING_GUIDE.md
```

> **Note on the two frontend dirs:** `ecopulse/` is the thin Vite host app
> (entry HTML, `main.jsx`, `App.jsx`, build config), while `frontend/` holds the
> actual feature code (pages, components, contexts). `App.jsx` imports its pages
> and providers from `../../frontend/...`, so the two are one logical app split
> for tooling reasons. This is why `package.json` at the root runs
> `cd ecopulse && npm run dev`.

---

## 4. Technology Stack

| Layer | Tech |
|-------|------|
| Smart contracts | Solidity `^0.8.28`, OpenZeppelin 5.x (ERC20, AccessControl, ReentrancyGuard, Pausable, Ownable2Step, SafeERC20) |
| Contract tooling | Hardhat Toolbox, Hardhat Ignition (deploy), TypeChain, hardhat-verify, Chai |
| Backend | Node.js 20+, Express 5, Mongoose 9, Socket.io 4, ethers v6, ioredis, MQTT.js, jsonwebtoken, bcryptjs, Helmet, express-rate-limit, PDFKit, Nodemailer |
| AI service | Python 3.11+, FastAPI, Uvicorn, TensorFlow/Keras (LSTM), scikit-learn (IsolationForest), pandas/numpy, joblib |
| GenAI service | Python 3.11+, FastAPI, Google Generative AI (Gemini) SDK, Pydantic |
| Frontend | React 19, Vite 6, React Router 7, TailwindCSS 4, Recharts, Leaflet (maps), ethers v6, socket.io-client |
| Datastores | MongoDB 7, Redis 7 |
| Blockchain | Ethereum (Sepolia testnet) / local Hardhat node |
| DevOps | Docker Compose, GitHub Actions CI, Dependabot, Gitleaks |

---

## 5. Smart Contracts Layer (Solidity / Hardhat)

All contracts live in `contracts/`, compile with Solidity `^0.8.28`
(`hardhat.config.js:8`), and deploy via a single Ignition module
(`ignition/modules/EnergySystem.js`). They form a small on-chain economy:

```
                 ┌──────────────────┐
                 │  CarbonCredit    │  ERC-20 "CC" token (capped supply)
                 │  (mint/burn/     │  ── holds MINTER_ROLE grants ──┐
                 │   retire)        │  ── linked registry ───────────┤
                 └────────┬─────────┘                                │
            trades settle  │  price = CC                             │
        in CC              ▼                                          │
   ┌──────────────┐   ┌──────────────┐                               │
   │EnergyTrading │   │ EnergyEscrow │ ◄── setDisputeResolution ──┐  │
   │ (list/buy/   │   │ (lock funds  │                             │  │
   │  partial)    │   │  until       │                             │  │
   └──────────────┘   │  delivery)   │     ┌──────────────────┐    │  │
                      └──────┬───────┘ ───►│DisputeResolution │    │  │
            claimTimeout/   │  executeRes │ (arbiter rules)  │    │  │
            release/dispute │  olution()  └──────────────────┘    │  │
                      └────────────────────────────────────────────┘  │
                                                                     │
   ┌──────────────────┐         ┌──────────────────────┐              │
   │RetirementRegistry│◄────────│   CarbonCreditBridge │◄─ grantMinter┘
   │ (record retire   │         │ (lock/mint/burn for  │
   │  + attest        │         │  cross-chain moves)  │
   │  provenance)     │         └──────────────────────┘
   └──────────────────┘
```

### 5.1 CarbonCredit (`CarbonCredit.sol`)
The fungible token at the heart of the economy (`contracts/CarbonCredit.sol`).

- **ERC-20** named "Carbon Credit" (`CC`), built on OpenZeppelin's `ERC20` +
  `AccessControl` + `ReentrancyGuard`.
- **Capped supply:** `maxSupply` is immutable and **must be > 0** (uncapped
  deployments are forbidden). A per-tx `maxMintPerTx` rate-limits minting.
- **Roles:** `DEFAULT_ADMIN_ROLE` (multisig in prod) and `MINTER_ROLE`
  (operational hot wallet / the bridge).
- **Minting** (`mint`) enforces the cap and per-tx limit; `grantMinter` /
  `revokeMinter` are admin-only.
- **Burning:** `burn` / `burnFrom` (allowance-consuming).
- **Retirement:** `retire` / `retireFrom` burn tokens AND emit a `Retired`
  event with a monotonic `retirementId` and a `certificateUri`. If a
  `RetirementRegistry` is linked, it pushes a record there. Tracks
  `totalRetired`, `totalRetirements`, and per-account retired totals.
- **On-chain audit marker:** `AUDIT_STATUS = "UNAUDITED"` (updated after audit).

### 5.2 EnergyTrading (`EnergyTrading.sol`)
The P2P order book for energy (`contracts/EnergyTrading.sol`).

- Sellers **list** energy (`listEnergy` never-expires, or `listEnergyWithExpiry`
  clamped to `[1 minute, 90 days]`).
- Buyers **purchase** the whole listing (`purchaseEnergy`) or a **partial fill**
  (`purchaseEnergyPartial`) — price scales proportionally, remaining amount/price
  decremented, listing auto-closes when fully filled.
- Settlement is instant: `safeTransferFrom` moves CC from buyer → seller (buyer
  must have approved the contract).
- **Self-cleaning expiry:** `expireListing` is callable by anyone once past the
  expiry timestamp (`ListingExpired` event).
- **Safety:** `ReentrancyGuard`, `Pausable` (owner kill-switch), `Ownable2Step`,
  cannot buy your own listing, custom errors for gas efficiency.

### 5.3 EnergyEscrow (`EnergyEscrow.sol`)
An **opt-in conditional settlement layer** (`contracts/EnergyEscrow.sol`).
Instead of instant transfer, funds are locked until the buyer confirms delivery.

- State machine: `Funded → Delivered → Released` (happy path), with branches to
  `Disputed` and `Refunded`.
- `createEscrow` pulls CC from buyer; `confirmDelivery` (seller attests);
  `release` (buyer pays seller); `openDispute` (within `disputeWindow`, bounded
  `[1h, 30d]`); `claimTimeoutRefund` (auto-refund if buyer never acts).
- `executeResolution` is the **trusted callback** invoked only by the linked
  `DisputeResolution` contract (Release / Refund / Split by basis points).

### 5.4 DisputeResolution (`DisputeResolution.sol`)
Records disputes and lets arbiters rule (`contracts/DisputeResolution.sol`).

- `ARBITER_ROLE` holders call `resolve(disputeId, outcome, buyerShareBps)`.
- `openDispute` is callable **only by the escrow** (not directly) — breaks the
  circular dependency via `setDisputeResolution`.
- The resolution is executed back on the escrow via `escrow.executeResolution(...)`.

### 5.5 RetirementRegistry (`RetirementRegistry.sol`)
On-chain audit log of carbon retirements with optional provenance
(`contracts/RetirementRegistry.sol`).

- Only the linked `CarbonCredit` token may call `record(...)` (writes a
  `Retirement` struct per `retirementId`).
- `ATTESTER_ROLE` later attaches verified provenance (`project`, `vintage`,
  salted `nodeHash`) via `attest` — one-shot per retirement.

### 5.6 CarbonCreditBridge (`CarbonCreditBridge.sol`)
A lock/mint bridge for cross-chain (or testnet) CC movement
(`contracts/CarbonCreditBridge.sol`). Bridges are the most-exploited contract
class, so this one layers many defenses:

- **Outbound:** `lock()` custodies CC and emits `Locked`; a relayer mints on the
  destination chain. **Return:** `returnToSource()` burns bridged CC; relayer
  releases originally-locked CC via `releaseBack()`. **Inbound:** `mintFor()`.
- Defenses: `RELAYER_ROLE`-gated, **one-time nonce consumption**
  (`processedNonces`) anti double-mint/release, `Pausable`, per-tx + rolling
  24h daily caps, same-chain rejection, supported-chain whitelist, CEI +
  ReentrancyGuard.

### 5.7 Interfaces & deployment
- `contracts/interfaces/` holds `IEnergyEscrow`, `IDisputeResolution`,
  `IRetirementRegistry` — these break constructor circular dependencies
  (escrow needs dispute, dispute needs escrow).
- `ignition/modules/EnergySystem.js` orchestrates the whole deploy: mints token,
  deploys trading + escrow + dispute, **links them post-deploy**
  (`setDisputeResolution`), and conditionally deploys the retirement registry +
  bridge (opt-out via `enableCarbonLifecycle=false`), granting the bridge
  `MINTER_ROLE`.
- **Mainnet gate:** `hardhat.config.js:19-26` throws if a mainnet network is
  configured without `MAINNET_AUDIT_ACK=confirmed`, tying deploys to
  `contracts/AUDIT_MANIFEST.json`.

---

## 6. Backend Service (Node.js / Express)

The backend (`backend/`) is the **central orchestrator** — the only service the
browser and devices talk to directly. Entrypoint: `backend/server.js`.

### 6.1 Startup & wiring (`server.js`)
`startServer()` does, in order:

1. `validateEnvironment()` — fail-fast on missing prod secrets.
2. `connectDB()` — Mongo.
3. Creates the Express app, an HTTP server, and calls `initSocket(server, app)`
   to bind Socket.io.
4. Registers global middleware (in order): CORS, compression, **Helmet**
   (security headers), JSON/urlencoded body parsers (1 MB cap), **CSRF token
   issuance**, **correlation-id** injection, **Prometheus metrics**, request
   logging.
5. Mounts health probes (`/api/health`, `/api/health/status`, `/api/health/ready`)
   and `/metrics` (token-protected in prod).
6. Mounts all feature routes under `/api/v1` (with CSRF protection).
7. 404 + central error handler.
8. **Starts background systems** after `server.listen`:
   - Blockchain sync (event listeners + a polling interval that also triggers
     reconciliation and analytics broadcast).
   - Carbon bridge event indexing.
   - Grid simulator (if `SIMULATOR_EMBEDDED=true`).
   - MQTT ingestion (if `MQTT_INGESTION_ENABLED=true`).
   - Time-series rollup worker (if `TIMESERIES_ENABLED=true`).
   - Public-grid poller, auto-listing matcher, reconciliation worker.
9. **Graceful shutdown** on `SIGTERM`/`SIGINT`: stops workers, closes socket,
   server, Redis, Mongo — with a forced-exit timeout (`SHUTDOWN_TIMEOUT_MS`).
   Server-level `requestTimeout=30s` mitigates slow-loris DoS.

### 6.2 Request pipeline (middleware → router → controller → service)

```
HTTP request
  → cors → helmet → body parsers → csrf(issue) → correlationId
  → metricsMiddleware → requestLogger
  → /api/v1  (csrfProtection)
      → protect (JWT verify) → requirePasswordCurrent → requireEmailVerified
      → apiRateLimit
      → routes/<feature>.js
      → controllers/<feature>Controller.js
      → services/<feature>Service.js   (business logic)
      → models/*.js (Mongoose)  /  blockchainService.js (ethers)  /  genaiClient.js
  → errorHandler (centralized, scrubs internals)
```

Key defensive choices in `server.js`:
- `app.set('query parser', 'simple')` — blocks NoSQL operator injection via
  `?field[$ne]=...`.
- `app.set('trust proxy', 1)` — honors `X-Forwarded-*` behind a load balancer.
- CORS allow-list from `CORS_ORIGIN` (comma-separated); rejects unknown origins.

### 6.3 Routing (`routes/`)
`routes/v1.js` is the **single aggregator** mounted at `/api/v1`. It composes a
guard chain and delegates to feature routers:

| Route prefix | Router | Guard notes |
|--------------|--------|-------------|
| `/auth` | `auth.js` | `/me` allowed pre-verification; password change allowed while flagged |
| `/nodes`, `/readings`, `/forecast`, `/anomaly`, `/analytics`, `/trades`, `/marketplace`, `/escrow`, `/disputes`, `/settlements`, `/carbon`, `/pricing`, `/trading`, `/assistant` | per-feature | Full user guard: `protect + requirePasswordCurrent + requireEmailVerified` + rate limit |
| `/admin` | `admin.js` (+ `admin/`) | `protect + requirePasswordCurrent + authorize('admin','moderator')` |
| `/telemetry` | `telemetry.js` | **Device** auth (x-device-id / x-api-key), OUTSIDE the user guard |

The guard chain (`guardedUser`) is: a valid JWT (`protect`), a current strong
password (`requirePasswordCurrent` — blocks users flagged `mustChangePassword`),
and a verified email (`requireEmailVerified`) when the feature requires it.

### 6.4 Controllers → Services
Controllers are thin HTTP adapters (`controllers/`). The real logic lives in
`services/`, which is large and domain-organized:

- **Trading/marketplace:** `marketplaceService.js`, `buyOrderService.js`,
  `listingCache.js`, `tradeHistoryService.js`, `tradeAggregationService.js`,
  `reputationService.js`.
- **Blockchain:** `blockchainService.js` (ethers contract wrappers —
  read-only + write), `blockchainSyncService.js` (event indexing),
  `bridgeService.js`, `retirementService.js`, `mintEligibilityService.js`.
- **Settlement:** `settlementLifecycleService.js`,
  `settlementVerificationService.js`, `settlementEscrowService.js`,
  `reconciliationService.js`, `escrowService.js`, `disputeService.js`.
- **Ingestion:** `mqtt/mqttIngestionService.js`, `ingestion/*`,
  `publicGrid/*`, `simulator/*`, `simulationService.js`,
  `services/timeseries/*`.
- **AI integration:** calls the Python services via HTTP clients
  (`genaiClient.js`, and an AI client inside `pricingEngine.js`).
- **Pricing:** `pricing/pricingEngine.js`, `surplusService.js`,
  `listingIntentService.js`, `autoTradingService.js`.
- **Analytics:** `analytics/*` (energy, carbon, trade, node, timeseries,
  auto-trading, flow).
- **Assistant:** `assistantRetrievers.js`, `assistantSessionStore.js`,
  `intentClassifier.js`, `assistantMetrics.js`, `retrievalService.js`.
- **Reports:** `reportService.js`, `pdfReportService.js`, `pdfConstants.js`.
- **Cross-cutting:** `auditService.js`, `healthService.js`,
  `socketBroadcastService.js`, `notificationService.js`, `emailService.js`,
  `walletLinkService.js`, `nodeMapService.js`, `deviceService.js`,
  `readingService.js`.

### 6.5 Data models (`models/`)
Mongoose schemas (28 collections). The important ones:

| Model | Purpose |
|-------|---------|
| `User` | Accounts: email/password (bcrypt), EIP-712 `walletAddress` link, `role`, login lockout, email verification, refresh/access token versions, ban/soft-delete. |
| `EnergyNode` | A physical/virtual metering node owned by a user (type, zone, capacity, ingestion mode). |
| `EnergyReading` / `EnergyReadingHourly` / `EnergyReadingTimeseries` | Raw + rolled-up telemetry (Mongo time-series collection). |
| `DeviceCredential` | Per-device API keys / MQTT credentials bound to a node. |
| `Trade` | Off-chain mirror of on-chain energy trades (synced from events). |
| `Escrow` | Mirror of `EnergyEscrow` state (synced from events). |
| `Settlement` | Trade settlement + verification + lifecycle fields. |
| `BuyOrder` / `ListingIntent` | Demand-side signed intents + auto-listing intents. |
| `Dispute` | Mirror of dispute state. |
| `Retirement` / `CreditAward` / `BridgeTransfer` | Carbon lifecycle records. |
| `Rating` / `Reputation` | Marketplace reputation. |
| `Notification` | User notifications. |
| `AuditLog` | Security-relevant actions. |
| `ReportJob` | Async PDF report generation jobs. |
| `AnomalyEvent` | Flagged anomalous readings. |
| `GridZone` / `PublicGridSource` / `AutoListingPolicy` / `AutoTradingConfig` / `SimulatorConfig` / `SyncState` / `IngestionError` | Configuration + operational state. |

---

## 7. AI Forecasting Service (Python / FastAPI)

Location: `ai_service/`. Entrypoint `main.py` → `app.factory.create_app()`.
Serves LSTM energy forecasts + anomaly detection. Port `8000`.

### 7.1 App structure (`app/`)
- `factory.py` — builds the FastAPI app: CORS (no `*` in prod), request-logging
  middleware, **internal-auth middleware** (rejects non-health requests without
  `x-internal-api-key`), exception handlers, and registers routers. The
  `lifespan` loads the forecast model on startup; the anomaly model is optional.
- `config.py` / `env_utils.py` — typed settings from env.
- `routers/` — `forecast`, `anomaly`, `models`, `health`, `metrics`.
- `services/` — `forecast_service.py`, `model_store.py`, `anomaly_service.py`,
  `ab_test_service.py` (model A/B testing + shadow logging), `forecast_cache.py`,
  `drift_monitor.py`.
- `internal_auth.py` — the shared `x-internal-api-key` gate.
- `schemas.py` — Pydantic request/response models.

### 7.2 The forecasting model (`models/forecasting.py`)
A **two-layer LSTM** (50 units each) with Dropout, output `Dense(horizon*2)`
(predicting generation + consumption per future step). Two prediction modes:

- **Multi-horizon (preferred):** `predict_multi_horizon` — a **single forward
  pass** yields the next `horizon` steps. Faster and more stable than recursion.
- **Legacy recursive:** `predict_future` — roll-forward one step at a time,
  feeding predictions back in.

Both sanitize output (NaN→0, negatives clipped to 0) because forecasts feed the
pricing engine and must never be NaN/negative.

### 7.3 Forecast orchestration (`forecast_service.py`)
`ForecastService.predict()`:
1. **Resolves the model** — explicit `model_version` (A/B / pinned) wins;
   otherwise per-node artifact; otherwise the global default model.
2. Loads history from Mongo (`utils.database.get_historical_data`), falls back
   to dummy data, then raises `InsufficientDataError` if still empty.
3. Builds the look-back window (`preprocessing.prepare_for_prediction`).
4. Runs the native-horizon pass or legacy recursion.
5. Formats results into `ForecastResult` rows with **confidence bands**
   (conformal per-step margins if available, else √-scaled conformal, else
   heuristic).

**Fallback ladder** (key resilience design): if no model is loaded and
`ALLOW_MODEL_FREE_DUMMY` is set, it returns a **heuristic** moving-average +
trend forecast so the endpoint never hard-fails. A/B challenger/traffic
splitting + shadow logging (score the champion offline for comparison) is built
into the `/forecast` router.

### 7.4 Anomaly detection (`models/anomaly_detection.py`)
An **unsupervised IsolationForest** (scikit-learn) scores each meter reading
0–1 (higher = more anomalous) with deterministic `reason_codes`. Trained via
`train_anomaly.py`; loaded optionally at boot.

### 7.5 Retrain pipeline
- `train.py` / `train_node.py` — global and per-node training scripts.
- `jobs/retrain_scheduler.py` — scheduled retraining.
- `.github/workflows/retrain-model.yml` — CI-driven retraining.
- Trained artifacts live under `models/registry/` and `models/saved/`.

---

## 8. GenAI Service (Python / FastAPI + Gemini)

Location: `genai-service/`. Entrypoint `main.py` → `app.factory.create_app()`.
Provides the **chat assistant** and **report narration** via Google Gemini.
Port `8001`.

### 8.1 App structure
Mirrors the AI service: `factory.py` builds the app with CORS, request logging,
internal-auth middleware, exception handlers (incl. a dedicated handler that
turns Gemini `RuntimeError`s into `503 fallback_available`), and a startup hook
that initializes `LlmService` and `DocRagService` onto `app.state`.

Routers: `assistant`, `reports`, `health`, `metrics`.

### 8.2 LLM service (`app/services/llm_service.py`)
- Wraps the **Google Generative AI (Gemini)** SDK.
- `is_available()` is false if `GEMINI_API_KEY` is unset or `GENAI_ENABLED=false`.
- `complete()` — plain text completion (with input truncation + token usage
  logging).
- `complete_json()` — forces JSON output (`response_mime_type=application/json`)
  and validates against a Pydantic schema.
- `complete_with_fallback()` — on any Gemini failure, returns a deterministic
  template-rendered reply (`fallback_templates.py`) so the UX never breaks.

### 8.3 Assistant router (`app/routers/assistant.py`)
`POST /assistant/chat`:
1. Trims conversation history, sanitizes the user message (≤1200 chars).
2. Builds a system + user prompt from `prompts.build_assistant_chat_prompt`,
  injecting `retrieved_data` (live platform metrics the backend gathered) and
  `doc_chunks` (Doc-RAG hits).
3. If Gemini is unavailable → return a fallback template reply.
4. Otherwise call Gemini, parse JSON, **sanitize** the reply (strip HTML/script
  tags, collapse whitespace, cap 4000 chars), and tag the disclaimer as demo vs
  live data.

`POST /assistant/doc-chunks` — retrieves RAG chunks; `POST /assistant/reindex`
rebuilds the embedding cache from the docs directory (only the configured dir
is ever read).

### 8.4 Reports router (`app/routers/reports.py`)
`POST /reports/narrate` turns a structured metrics payload into a plain-English
`summary` + `highlights`, again with a JSON-validated response and a fallback
template. This is what powers human-readable PDF report narration.

### 8.5 Doc-RAG (`app/services/doc_rag_service.py`)
A lightweight retrieval index over `docs/assistant/*.md` (the assistant
knowledge base) so the LLM can cite platform documentation.

---

## 9. Frontend (React + Vite)

The frontend is split into a **host app** (`ecopulse/`) and **shared feature
code** (`frontend/`).

### 9.1 Host app (`ecopulse/`)
- `index.html`, `src/main.jsx` (React DOM root), `src/App.jsx` (route tree).
- `vite.config.js` resolves the `../../frontend/...` imports so the host builds
  the shared code.
- `package.json` deps: React 19, React Router 7, Tailwind 4, Recharts, Leaflet,
  ethers v6, socket.io-client.

### 9.2 Route tree (`App.jsx`)
Provider nesting from outer to inner: `ToastProvider → AuthProvider →
BrowserRouter → WalletProvider → SocketProvider`. Two route regions:

- **Guest routes:** `/login`, `/register`, `/verify-email`.
- **Authenticated app** (`ProtectedRoute`): an **admin section**
  (`/admin/*`, role-gated to `admin`/`moderator`, distinct `AdminLayout`) with
  pages for users, nodes, trades, report jobs, sync status, audit logs, health,
  simulator, ingestion; and a **user section** (`AppLayout`): Dashboard,
  Trading, AutoTrading, CarbonTransactions, CarbonWallet, Forecasts, Credits,
  Settings. A lazy-loaded `AssistantChat` widget overlays the user section.

### 9.3 State via context providers (`frontend/context/`)
- `AuthContext` — login/register/refresh, user profile, email verification.
- `SocketContext` — manages the Socket.io connection lifecycle.
- `WalletContext` — MetaMask connection + on-chain wallet state.
- `ToastContext` — global notifications.

### 9.4 Data hooks (`frontend/hooks/`)
React hooks that wire the UI to realtime + REST:
`useDashboardRealtime`, `useAssistantChat`, `useNodeForecast`,
`useSettlementStatus`, `settlementSocket`, `useVisibilityPolling`.

### 9.5 API & infra utilities (`frontend/utils/`)
- `api.js` — the central fetch client. Base URL from `VITE_API_URL`
  (required in prod). Handles **CSRF** (reads/refreshes the `csrfToken` cookie,
  sends `x-csrf-token`), **auth token attach + transparent refresh**, cold-start
  retry, timeout, and normalizes errors into `ApiError`.
- `socketClient.js` — Socket.io factory bound to `VITE_SOCKET_URL`.
- `blockchain.js` / `walletLink.js` / `walletStorage.js` — ethers + wallet-link
  helpers.
- `permissions.js`, `validation.js`, `captcha.js`, `safeRedirect.js`, etc.

### 9.6 Components (`frontend/components/`)
`AppLayout`, `Sidebar`, `WalletConnect`, `BlockchainStatus`,
`ProtectedRoute`/`GuestRoute`, `SessionBridge`, `EmailVerificationBanner`,
`AppErrorBoundary`, plus feature folders: `assistant/`, `dashboard/`,
`trading/`, `settlement/`, `settings/`, `admin/`, and `ui/` primitives.

---

## 10. Datastores

### MongoDB (`config/db.js`)
The primary OLTP store. All 28 Mongoose collections live here. The backend
shares the `ecopulse` database; the AI service also reads historical readings
from it (`ai_service/utils/database.py`). In Docker Compose this is `mongo:7`
with a persistent volume.

### Redis (`config/redis.js`)
Optional but used for:
- **Rate limiting** (`middleware/rateLimitMemory.js` falls back to in-memory if
  Redis is down — the platform degrades rather than hard-fails).
- **Pricing curve cache** (`pricing:curve:*`, 5-min TTL).
- **MQTT device-cache** lookups.

In Docker Compose this is `redis:7-alpine`. The backend works without Redis in
dev (in-memory fallbacks), but prod-grade rate limiting expects it.

### Ethereum (the blockchain)
- **Reads:** via a `JsonRpcProvider` (local Hardhat `127.0.0.1:8545` in dev,
  Sepolia RPC in prod).
- **Writes:** via a deployer `Wallet` (from `PRIVATE_KEY`) wrapped in a
  `NonceManager` to serialize nonces (`blockchainService.js:19-25`). This is the
  contract owner/minter and is explicitly flagged as a centralization risk
  pending multisig.
- Contract addresses come from env (`CARBON_CREDIT_ADDRESS`, etc.).

---

## 11. How Everything Connects (End-to-End Flows)

### Flow A — User asks the assistant a question
```
Browser (AssistantChat)
  → POST /api/v1/assistant/chat  (JWT + CSRF)
  → assistantController.postAssistantChat
      → assistantRetrievers: gathers the user's live metrics (energy,
        carbon, trades) by reading Mongo + the blockchain (read-only)
      → intentClassifier: classifies intent
      → genaiClient.postChat(payload)  ──HTTP + x-internal-api-key──►
            genai-service /assistant/chat
              → build_assistant_chat_prompt (injects retrieved_data + doc_chunks)
              → LlmService.complete (Gemini)  OR  fallback template
              → sanitize reply, tag demo/live disclaimer
      ◄── { reply, disclaimer }
  → Socket/REST update the chat UI
```

### Flow B — A prosumer lists energy and a consumer buys it
```
1. Seller (browser)  → /api/v1/marketplace  → backend → blockchainService.listEnergy
     → EnergyTrading.listEnergy() on-chain → emits EnergyListed
2. blockchainSyncService indexes the event → Trade/listing cached in Mongo
     → Socket.io ORDERBOOK_UPDATE pushed to all clients
3. Buyer sees order book → /marketplace → blockchainService.purchaseEnergy
     → EnergyTrading.purchaseEnergy() → CC transferred buyer→seller → EnergyPurchased
4. Sync indexes → Trade doc created → TRADE_EXECUTED socket event → ticker updates
5. (If escrow used) settlement lifecycle worker verifies on-chain + readings
```

### Flow C — Forecast request
```
Browser (Forecasts page)
  → /api/v1/forecast  → forecastController
      → HTTP to ai_service /forecast/  (x-internal-api-key)
        → ForecastService.predict
            → load model (version/per-node/global)
            → get_historical_data (Mongo)
            → prepare_for_prediction → predict_multi_horizon (LSTM)
            → format with confidence bands
      ◄── predictions + model_status + version
  → Recharts renders generation/consumption curves
```

### Flow D — Telemetry ingestion (the data foundation)
```
Device publishes JSON to MQTT topic ecopulse/nodes/<nodeId>/telemetry
  → mqttIngestionService resolves device+node (TTL cache), validates ACL,
     enforces TLS in prod, payload size cap
  → processDeviceTelemetry (ingestion/telemetryService)
      → validate schema (telemetrySchema) → dedup (dedup.js) → write EnergyReading
      → optionally roll up to hourly / time-series collection
      → anomaly scoring (ai_service) → AnomalyEvent
      → Socket.io NEW_READING + ANALYTICS_UPDATE to the node's owner
```

---

## 12. Energy Ingestion Pipeline

The platform supports **four** ingestion sources, all funneling through one
normalized pipeline (`services/ingestion/`):

1. **MQTT** (`mqtt/mqttIngestionService.js`) — subscribes to
   `ecopulse/nodes/+/telemetry`. TLS-only in prod, lazy-loaded `mqtt` package,
   per-device credentials + topic ACL, payload size cap, TTL device cache.
2. **HTTP push** (`/api/v1/telemetry`) — device auth (`x-device-id` /
   `x-api-key` via `middleware/deviceAuth.js` + `deviceRateLimit.js`), mounted
   outside the user guard.
3. **Public grid APIs** (`services/publicGrid/` + `publicGridPoller.js`) — pulls
   from configured public sources through adapters; bounded by
   `PUBLIC_GRID_INGESTION_ENABLED`.
4. **Embedded simulator** (`services/simulator/`, `simulatorManager.js`,
   `simulate_nodes.js`) — generates realistic synthetic readings for demos;
   starts only when `SIMULATOR_EMBEDDED=true`.

All paths converge on `processDeviceTelemetry` → schema validation
(`telemetrySchema.js`) → dedup (`dedup.js`) → `EnergyReading` write → optional
time-series + hourly rollup (`services/timeseries/`) → metrics
(`ingestionMetrics.js`) → anomaly scoring → socket broadcast.

### Time-series optimization
When `TIMESERIES_ENABLED=true`, `timeseriesSetup.ensureAll()` creates a Mongo
**time-series collection** + indexes, and `rollupWorker.js` aggregates raw
readings into hourly buckets (`EnergyReadingHourly`) for efficient long-range
analytics and forecasting input.

---

## 13. AI Forecasting & Pricing

### Forecasting (covered in §7)
Per-node or global LSTM forecasts with conformal confidence bands. The AI
service supports **model versioning** (registry), **per-node models** (with
global fallback + LRU cache), **A/B testing** (deterministic per-node traffic
split + shadow logging the champion), and **drift monitoring**.

### Pricing engine (`services/pricing/pricingEngine.js`)
Turns forecast output + marketplace analytics into a **kWh price curve**
(credits/kWh). It is explicitly **read-only** — never touches wallets, private
keys, or the blockchain write path. Curves are **recommendations** surfaced to
the UI; the on-chain marketplace remains the source of truth for executed
prices.

Formula (v1):
```
basePrice       = historicalAvgUnitPrice || DEFAULT_BASE
surplusRatio    = (forecastGen - forecastCon) / max(forecastCon, MIN_DEMAND)
marketSurplus   = listedEnergyKw / max(forecastGen + listedEnergyKw, 1)
combinedSurplus = clamp(surplusRatio*(1-MARKET_PRESSURE) + marketSurplus*MARKET_PRESSURE, -1, 2)
hourlyPrice     = clamp(basePrice * (1 - SURPLUS_COEFF * combinedSurplus), floor, ceiling)
```
Guardrails: rejects NaN/negative/non-finite forecasts, hard-clamps every output
to `[floor, ceiling]`, Redis-caches curves (5-min), returns a full input
snapshot for auditability.

### Surplus & auto-trading
- `surplusService.js` — computes node energy surplus (the sellable excess).
- `autoTradingService.js` + `listingIntentService.js` + `AutoListingPolicy` —
  automate listing surplus energy for sale. The `autoListingMatcher` worker
  matches intents to the order book; a runtime kill-switch (admin) takes effect
  without a restart.

---

## 14. Energy Marketplace & Trading

The marketplace has a **sell side** (on-chain listings) and a **demand side**
(off-chain signed buy intents), plus history, reputation, and settlement
surfaces — all behind `/api/v1/marketplace`.

### Sell side (on-chain)
`EnergyTrading` listings (see §5.2). The backend:
- Reads active listings via `blockchainService.getActiveListings` (chunked RPC,
  drops expired-but-unpruned listings), cached in `listingCache.js`.
- Writes listings/purchases via the deployer wallet.

### Demand side (off-chain buy orders)
`BuyOrder` signed intents (`routes/marketplace.js` `/orderbook/buy-orders`) —
EIP-712 signed demand that the `autoListingMatcher` can match against listings,
under a tighter rate limit.

### Trade history & ticker
`marketplaceTradeHistoryController` + `tradeHistoryService` expose the trade
tape, recent trades, aggregates, and per-tx detail. A compact anonymized
`TRADE_EXECUTED` socket event (fired only from the realtime listener, never
historical backfill) powers the live ticker.

### Reputation (`reputationController` / `reputationService`)
Ratings + aggregated reputation per wallet/node, with eligibility guards
(verified-trade participation, self-rating block) and a dedicated rate limiter.

---

## 15. Escrow, Settlement & Dispute Resolution

For higher-trust trades, `EnergyEscrow` (§5.3) locks CC until delivery is
confirmed. The backend mirrors escrow + settlement state and collapses three
independent state sources into **one user-facing lifecycle**
(`settlementLifecycleService.js`):

```
pending → on_chain_confirmed → readings_verified → released
                                                       (terminal branches:
                                                        mismatch | disputed | refunded)
```

The three raw sources it merges:
- `Settlement.onChainStatus` — receipt/block confirmations
  (`settlementVerificationService`).
- `Settlement.verificationStatus` — meter-telemetry reconciliation
  (`reconciliationService` + `reconciliationWorker`).
- `Escrow.state` — escrow contract events (Released/Refunded/Disputed).

The lifecycle function is **pure and deterministic** (no IO) so it's trivially
unit-testable and safe to run on every read. Precedence is terminal-first so a
release can never mask a dispute/refund.

### Disputes
A buyer opens a dispute within the `disputeWindow` → escrow calls
`DisputeResolution.openDispute` → an arbiter rules (`resolve`) → escrow
executes Release/Refund/Split. The backend mirrors `Dispute` docs and exposes
`/api/v1/disputes`.

---

## 16. Carbon Credit Lifecycle (Mint → Trade → Retire → Bridge)

This is the economic loop tying green generation to value:

```
   Green generation (verified meter data)
        │  mintEligibilityService decides eligibility
        ▼
   CarbonCredit.mint()  ──►  CC in user's wallet
        │  (MINTER_ROLE held by backend deployer / bridge)
        │
        ├──► Trade for energy  (EnergyTrading / EnergyEscrow)
        │
        ├──► Retire (burn)  ──► RetirementRegistry.record()
        │      + optional ATTESTER provenance (project/vintage/nodeHash)
        │      + certificateUri (IPFS/HTTPS)
        │
        └──► Bridge cross-chain  (CarbonCreditBridge)
                lock() → relayer mintFor() on dest chain
                returnToSource() (burn) → relayer releaseBack()
```

- **Minting** is gated by `mintEligibilityService` (rewards verified green
  generation) and the on-chain supply cap + per-tx limit.
- **Trading** moves CC as the settlement currency (§14/§15).
- **Retirement** permanently burns CC and issues a retirement certificate with
  a monotonic id; the registry records it and an attester can later attach
  verified provenance.
- **Bridging** moves CC across chains via a lock/mint (outbound) and
  burn/release (return) pattern with one-time nonces, caps, and relayer gating.

---

## 17. Real-Time Layer (Socket.io)

`socket/index.js` initializes Socket.io on the HTTP server; `events.js` defines
the **canonical event names** (client ↔ server). Server→client events:

| Event | Purpose |
|-------|---------|
| `newReading` | A new telemetry reading for a node the client owns/watches. |
| `analyticsUpdate` | Aggregated dashboard analytics changed. |
| `blockchainEvent` | A relevant on-chain event was indexed (trade, escrow, …). |
| `notification` | A user notification. |
| `settlementVerified` / `settlementMismatch` | Settlement reconciliation outcome. |
| `orderbookUpdate` | Compact "order book changed" push (clients refetch their page). |
| `tradeExecuted` | Compact anonymized live trade for the ticker (realtime only). |

`socketBroadcastService.js` is the single funnel for emitting these (incl. a
`flushAnalytics` mode called after blockchain sync). Client→server: the
`simulateReading` event feeds the simulator. The frontend `SocketContext` +
hooks consume these to update the UI without polling.

---

## 18. Authentication, RBAC & Security Model

### Authentication (`middleware/auth.js`, `authController.js`)
- **JWT** access + refresh tokens with version counters on the `User` doc
  (`accessTokenVersion`, `refreshTokenVersion`) for instant revocation.
- Passwords hashed with **bcryptjs**; login lockout after 5 attempts (15-min
  lock); email verification (24h token, hashed at rest).
- `mustChangePassword` flag → `requirePasswordCurrent` guard blocks feature
  access until the user resets.
- **Wallet linking** via **EIP-712** signature challenge
  (`/auth/wallet/challenge` → `/auth/wallet/link`). `walletAddress` is
  `unique + sparse` — the single source of truth for carbon balances, trades,
  and settlements.
- **CSRF** (`middleware/csrf.js`) — double-submit token via `csrfToken` cookie +
  `x-csrf-token` header; `/api/v1` is CSRF-protected.
- **reCAPTCHA** (`middleware/captchaVerify.js`) on registration/login.

### RBAC (`auth/roles.js`, `auth/permissions.js`)
EcoPulse separates **app identity roles** from **node types**:

| Role | Capabilities |
|------|--------------|
| `consumer` | Own nodes (CRUD own), execute trades, transfer carbon. |
| `prosumer` | Same as consumer (owns producer/consumer nodes). |
| `grid_operator` | **Zone-scoped read** of nodes + analytics in assigned zones; no global data, no writes. |
| `moderator` | Read all nodes/trades/analytics, admin access, user management. |
| `admin` | Wildcard `'*'` — every permission (superuser). |

Unknown roles resolve to **no permissions (fail-closed)**.
`middleware/requirePermission.js` enforces per-route checks; `grid_operator`
visibility is enforced by `assignedZoneIds` (Module 8.3).

### Service-to-service auth
The backend calls the Python services with `x-internal-api-key`
(`INTERNAL_SERVICE_API_KEY`, **required in prod**). Both Python factories reject
any non-`/health` request missing/mismatching the key. Outbound logs are
**scrubbed** (`utils/scrubLog.js`) so internal hostnames/IPs never leak.

### Other defenses
- Helmet security headers + HSTS (prod), compression, 1 MB body cap.
- NoSQL-operator-injection blocking (simple query parser).
- Slow-loris mitigation (`requestTimeout=30s`).
- Rate limiting (Redis-backed, in-memory fallback) with per-endpoint tunings
  (chat, ratings, buy-orders, health-status).
- Graceful shutdown draining all workers/connections.
- Gitleaks + Dependabot + the `scripts/predeploy-check.js` gate.

---

## 19. Background Workers

`server.js` starts several schedulers, each `start()`/`stop()`-able and
re-reading its enable flag per-tick:

| Worker | File | Role |
|--------|------|------|
| Blockchain sync | `blockchainSyncService` + inline interval | Indexes trade/escrow/bridge events; triggers reconciliation + analytics broadcast. |
| Rollup | `workers/rollupWorker.js` | Aggregates raw readings → hourly buckets (time-series). |
| Public-grid poller | `workers/publicGridPoller.js` | Pulls from configured public grid APIs. |
| Auto-listing matcher | `workers/autoListingMatcher.js` | Matches surplus auto-listing intents to the order book (respects admin kill-switch). |
| Reconciliation | `workers/reconciliationWorker.js` | Reconciles `Settlement` docs against meter telemetry; backfills gaps. |

All workers are stopped during graceful shutdown.

---

## 20. Observability (Metrics, Logging, Health)

### Metrics
- **Prometheus** scrape endpoints at `/metrics` on all three app tiers
  (backend, ai-service, genai-service). In prod, `/metrics` is **disabled unless
  `METRICS_TOKEN` is set** and is scraped with a `Bearer`/`x-metrics-token`.
  (`middleware/metricsMiddleware.js`, `routes/metrics.js`, and the Python
  `app/metrics.py` + `routers/metrics.py`.)

### Logging
- Structured logging (`utils/logger.js`) with **correlation IDs**
  (`middleware/correlationId.js`) propagated across services.
- Outbound request logging + log scrubbing (`utils/scrubLog.js`) to prevent
  internal host/IP/secret leakage.
- The Python services share a structured logging setup (`app/logging_config.py`).

### Health
Three backend probes:
- `GET /api/health` — minimal public liveness probe (no internals) for load
  balancers.
- `GET /api/health/status` — aggregated multi-tier status with **safe fields
  only** (no hosts/ports/versions/error strings); rate-limited.
- `GET /api/health/ready` — returns `503` only when a **critical** dependency
  (Mongo/backend) is down, so partial degradation doesn't evict the backend
  from rotation.
- The Python services expose `/health` per a shared contract
  (`shared/healthContract.json`, `app/health_contract.py`).

---

## 21. Deployment & DevOps

### Local dev (per the root README)
```bash
# Backend
cp backend/.env.example backend/.env   # Mongo URI, JWT secrets, …
npm install --prefix backend && npm run dev --prefix backend   # :5000

# AI services
pip install -r ai_service/requirements.txt
pip install -r genai-service/requirements.txt
uvicorn main:app --reload --port 8000     # in ai_service/
uvicorn main:app --reload --port 8001     # in genai-service/

# Frontend
npm install --prefix ecopulse && npm run dev --prefix ecopulse   # :5173

# Smart contracts
npx hardhat compile        # compile
npx hardhat test           # test
npx hardhat node           # local chain on :8545
```

### Docker (production-parity) — `docker-compose.yml`
Brings up the whole stack: `mongodb` (7), `redis` (7-alpine), `ai-service`
(:8000), `genai-service` (:8001), `backend` (:5000), each built from its own
`Dockerfile`. The backend is wired to Mongo/Redis/AI/GenAI via internal service
URLs and the shared `INTERNAL_SERVICE_API_KEY`. An optional `prometheus`
scraper is commented out. CORS origin defaults to `http://localhost:5173`.

### Contract deployment
```bash
npm run predeploy:check               # safety gate (scripts/predeploy-check.js)
npm run deploy:sepolia                # Ignition deploy to Sepolia
```
`EnergySystem.js` deploys + links all contracts. **Mainnet is intentionally
omitted** and blocked by `hardhat.config.js` until `MAINNET_AUDIT_ACK=confirmed`.

### CI/CD (`.github/workflows/`)
- `ci.yml` — four jobs on every push/PR to main/master: **backend tests**
  (`node --test`), **frontend build** (`vite build`), **contract tests**
  (`hardhat test`), **AI-service** + **genai-service** Python tests.
- `security.yml`, `deploy.yml`, `retrain-model.yml` — security scans, deploys,
  and model retraining.
- `dependabot.yml` keeps deps current; `.gitleaks.toml` scans for secrets.

### Production readiness
The repo is explicit that this is pilot-grade. `production_time.md`,
`P2P_Trading_Production_Readiness.md`, and
`docs/EcoPulse_Deployment_Readiness.md` track the open Critical/High items:
authorization hardening, graceful shutdown, CI, CAPTCHA, **contract audit**,
and Redis/time-series scaling. Smart contracts must **not** go to mainnet
without a formal audit + multisig governance.

---

## 22. Testing Strategy

| Area | Runner | Location | Command |
|------|--------|----------|---------|
| Backend (Node) | `node --test` | `backend/tests/*.test.js` | `npm run test:security --prefix backend` |
| Smart contracts | Hardhat + Chai | `test/*.test.js` | `npm run test:contracts` (root) |
| AI service | `unittest` | `ai_service/tests/test_*.py` | `python -m unittest discover -s ai_service/tests` |
| GenAI service | `unittest` | `genai-service/tests/test_*.py` | `python -m unittest discover -s genai-service/tests` |
| Frontend | ESLint + Vite build | `frontend/tests/`, `ecopulse` lint | `npm run lint` / `npm run build --prefix ecopulse` |

Backend tests are extensive and security-focused: RBAC, multi-tenancy, node
ownership, wallet linking, trade history, reconciliation, settlement sockets,
order book, pricing, telemetry, ingestion, observability, log scrubbing, and
the layered "low/medium/performance fixes" suites. `SYSTEM_TESTING_GUIDE.md`
documents end-to-end manual testing.

---

## 23. Glossary

- **CC / CarbonCredit** — the fungible ERC-20 token; the settlement currency.
- **Prosumer** — a user who both produces (e.g. solar) and consumes energy.
- **Node** — a physical/virtual metering device owned by a user.
- **Listing** — on-chain energy-for-CC sell offer in `EnergyTrading`.
- **BuyOrder** — off-chain EIP-712 signed demand intent.
- **Escrow** — locked CC awaiting delivery confirmation (`EnergyEscrow`).
- **Settlement** — the backend's record of a trade's on-chain + telemetry state.
- **Retirement** — permanently burning CC to offset carbon; recorded in
  `RetirementRegistry`.
- **Conformal bands** — calibrated uncertainty intervals on forecasts.
- **Rollup** — aggregating raw telemetry into hourly buckets.
- **Internal API key** — shared secret gating backend↔Python service calls.
- **Kill-switch** — admin pause for the marketplace / auto-trading.

---

*This document describes the repository as committed. For the authoritative,
per-component details, follow the `file:line` references inline and the existing
docs under `docs/` and `contracts/SECURITY.md`. Contracts and the platform as a
whole are **unaudited** — treat all on-chain flows and mainnet paths as
not-yet-production-ready.*

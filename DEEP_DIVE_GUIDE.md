# EcoPulse — Deep Code Walkthrough

> A granular, file-by-file explanation of the EcoPulse codebase: what each file
> does, the key functions it exports (with `file:line` references), and how the
> pieces wire together. This is the companion to `PROJECT_OVERVIEW.md` — read
> that first for the high-level architecture, then use this to navigate the code.
>
> Generated from a full source read of backend, ai_service, genai-service,
> frontend, contracts, and tooling.

---

## Table of Contents

- [0. How to read this document](#0-how-to-read-this-document)
- [1. Backend Deep Dive](#1-backend-deep-dive)
  - [1.1 Entrypoint & startup](#11-entrypoint--startup)
  - [1.2 Config layer](#12-config-layer)
  - [1.3 Middleware layer](#13-middleware-layer)
  - [1.4 Auth & RBAC](#14-auth--rbac)
  - [1.5 Models (Mongoose)](#15-models-mongoose)
  - [1.6 Routes](#16-routes)
  - [1.7 Controllers](#17-controllers)
  - [1.8 Services](#18-services)
  - [1.9 Workers](#19-workers)
  - [1.10 Simulator subsystem](#110-simulator-subsystem)
  - [1.11 Public-grid ingestion](#111-public-grid-ingestion)
  - [1.12 Socket layer](#112-socket-layer)
  - [1.13 Utils](#113-utils)
  - [1.14 Admin controllers & routes](#114-admin-controllers--routes)
  - [1.15 Scripts](#115-scripts)
  - [1.16 Templates](#116-templates)
- [2. AI Service Deep Dive](#2-ai-service-deep-dive)
- [3. GenAI Service Deep Dive](#3-genai-service-deep-dive)
- [4. Frontend Deep Dive](#4-frontend-deep-dive)
- [5. Smart Contracts Recap](#5-smart-contracts-recap)
- [6. End-to-End Execution Walkthroughs](#6-end-to-end-execution-walkthroughs)

---

## 0. How to read this document

Each entry follows the same shape:

```
path/to/file.js   (N lines)
Responsibility: the file's single job.
Key functions:
  • name (file.js:LINE) — what it does.
Connections: what depends on it / what it depends on.
```

When a line range like `file.js:45–67` appears, that's where the logic lives in
the repo. `file:line` references are how you should jump straight into the
source. Security-relevant choices are called out explicitly because the
codebase itself is defensive-by-design.

---

# 1. Backend Deep Dive

The backend (`backend/`) is the **single public entry point** for browsers and
devices. Node.js 20+, Express 5, Mongoose 9, ethers v6, Socket.io 4, ioredis,
MQTT.js. Entrypoint: `backend/server.js`.

## 1.1 Entrypoint & startup

### `backend/server.js` (291 lines)
**Responsibility:** Bootstrap the whole backend — wire middleware, mount
routes, start workers, and own the graceful-shutdown lifecycle.

- `startServer()` (`server.js:36`) is the orchestrator. In order:
  1. `validateEnvironment()` (`config/env.js`) — fail-fast in prod.
  2. `connectDB()` (`config/db.js`) — Mongo.
  3. Creates Express app + `http.createServer`; `initSocket(server, app)`
     (`socket/index.js:37`) binds Socket.io **before** `listen`.
  4. Global middleware chain, in order (`server.js:64–92`):
     `cors → compression → helmet → express.json(1mb) → urlencoded →
     issueCsrfToken → correlationId → metricsMiddleware → requestLogger`.
  5. Health probes: `/api/health` (minimal), `/api/health/status`
     (rate-limited, safe-fields-only aggregator), `/api/health/ready`
     (returns `503` only when Mongo/backend critical dependency down).
  6. `/metrics` (token-protected in prod).
  7. `/api/v1` with CSRF protection → `routes/v1.js`.
  8. 404 + central `errorHandler`.
- **Defensive settings** baked in: `query parser = simple` (blocks NoSQL
  operator injection via `?field[$ne]=…`), `trust proxy = 1` (for LBs),
  `server.requestTimeout = 30s` (slow-loris mitigation).
- **Background systems** started after `listen` (`server.js:250–285`):
  blockchain sync listeners + interval, bridge event indexing,
  `simulatorManager.startIfEnabled()`, `mqttIngestionService.start()`,
  time-series setup + `rollupWorker`, `publicGridPoller.start()`,
  `autoListingMatcher.start()`, `reconciliationWorker.start()`.
- **Graceful shutdown** (`server.js:193`): on SIGTERM/SIGINT sets `shuttingDown`
  flag, stops all workers + listeners, closes socket, HTTP server, Redis, Mongo
  — with a forced-exit timer (`SHUTDOWN_TIMEOUT_MS`, default 15s).

### `backend/index.js` (5 lines)
A stub that just tells you to run `npm run dev --prefix backend`. The real
entrypoint is `server.js`.

---

## 1.2 Config layer

The `backend/config/` folder is the **single source of truth** for environment,
datastores, and feature knobs. Every value is validated at boot.

### `config/env.js` (138 lines)
**Responsibility:** Production startup validator + a few runtime policy helpers.
- `HARDHAT_DEFAULT_KEY_SHA256` (`env.js:6`) — hash of the well-known Hardhat
  account-#0 key; `isKnownDevPrivateKey()` (`:8`) detects and **rejects** using
  it in production (so nobody accidentally deploys with the Hardhat dev key).
- `isEmailVerificationRequired()` (`:23`) — on by default in prod.
- **`validateEnvironment()` (`:29`)** — the boot gate. In prod it requires:
  JWT access/refresh secrets ≥32 chars and **different**; `MONGO_URI`;
  `CORS_ORIGIN`; `INTERNAL_SERVICE_API_KEY`; (if blockchain) `RPC_URL` +
  contract addresses + non-dev `PRIVATE_KEY`; a CAPTCHA provider;
  `REDIS_URL`; `AI_SERVICE_URL`; `GENAI_SERVICE_URL`. Warns (not fails) on
  missing SMTP / `REGISTRATION_OPEN`. Collects all issues into one thrown error.

### `config/db.js` (50 lines)
**Responsibility:** Mongo connection lifecycle.
- `connectDB()` (`db.js:3`) — rejects the placeholder Mongo URI; sets
  `maxPoolSize` (env, default 50), `serverSelectionTimeoutMS:10000`,
  `socketTimeoutMS:45000`, `retryWrites:true`.
- `disconnectDB()` (`:43`) — no-op if already disconnected.

### `config/redis.js` (101 lines)
**Responsibility:** Singleton ioredis client (TLS-aware) for distributed rate
limiting + caches.
- `buildTlsOptions()` (`:8`) — only for `rediss://`; rejects
  `REDIS_TLS_INSECURE=true` in prod; reads CA from `REDIS_TLS_CA_CERT`.
- `getRedisClient()` (`:32`) — lazy, cached, guarded against concurrent
  creation; `retryStrategy` gives up after 5 tries.
- `isRedisAvailable()` (`:97`) — `client !== null && client.status === 'ready'`.
  This is the gate `rateLimit.js` uses to choose Redis vs in-memory.

### `config/serviceUrls.js` (47 lines)
**Responsibility:** Resolve outbound URLs (AI, GenAI, RPC) with
prod-required/dev-default semantics.
- `resolveServiceUrl(envVar, devDefault)` (`:9`) — returns env value or dev
  default; **throws in prod** if required and missing.
- `getAiServiceUrl()` (`:20`) → `AI_SERVICE_URL` (dev `http://localhost:8000`).
- `getGenaiServiceUrl()` (`:25`) → `GENAI_SERVICE_URL` (dev `:8001`).
- `getRpcUrl()` (`:30`) → `RPC_URL` (dev `http://127.0.0.1:8545`).

### `config/socket.js` (23 lines)
Socket.io CORS + keepalive options from `SOCKET_CORS_ORIGIN`/`FRONTEND_URL`.
`getSocketServerOptions()` (`:13`) → `{ cors, pingInterval, pingTimeout }`.

### `config/ingestionMode.js` (122 lines)
**Responsibility:** Which telemetry sources are active (`simulated` / `device`
/ `public_api` / `hybrid`), driven by `INGESTION_MODE` + `NODE_ENV`.
- Defaults: dev → `hybrid`, prod → `public_api`.
- `isSimulatorLockedDown()` (`:78`) — `isProduction() && !isSimulatorAllowed()`.
  This is the **production guardrail** that prevents demo data mixing with live
  data.
- `getStatus()` (`:91`) — snapshot for the admin ingestion dashboard.

### `config/timeseries.js` (66 lines)
Time-series migration knobs: `TIMESERIES_ENABLED`, `TIMESERIES_DUAL_WRITE`
(default true — writes go to BOTH legacy + `_ts` collections), TTLs
(`RAW_TTL_DAYS=90`, `ROLLUP_TTL_DAYS=730`), `ROLLUP_INTERVAL_MS` (1h),
`ANALYTICS_READ_PREFERENCE` (`secondaryPreferred`).

### `config/pricing.js` (166 lines)
Every knob for the **read-only** pricing engine. Hard floor/ceiling clamp
(`clampPrice` `:130`, NaN→floor), algo version `PRICING_ALGO_VERSION='1.0.0'`,
surplus coefficient, market blend weights, confidence band scales, curve
horizon `[1h,168h]`, 5-min Redis cache TTL.

### `config/publicGrid.js` (147 lines)
Public-grid poller config + the **SSRF guard** `isPrivateHost(hostname)`
(`:87`) — blocks loopback/private/CGNAT/link-local/cloud-metadata addresses
(defense-in-depth against DNS rebinding). Per-source allowlists are the primary
control.

### `config/walletLink.js` (54 lines)
EIP-712 domain for wallet↔user binding. **No `verifyingContract`** (off-chain
attestation). Short challenge TTL (`WALLET_LINK_CHALLENGE_TTL_MS`, default 5
min) + failed-attempt lock.

### `config/autoTrading.js` (224 lines)
Auto-listing engine config. **Fail-closed** master flag
`isAutoTradingEnvEnabled()` (`:54`, default false) + `isAutoSubmitEnabled()`
(`:60`, default false — v1 is **notify-only**: the server never holds private
keys). Hard per-day limits (`ABSOLUTE_MAX_LISTINGS_PER_DAY=24`), EIP-712 intent
domain, Redis quota/idempotency key prefixes, `MICRO_CC_SCALE=1_000_000n` for
scaling fractional cc into uint256 EIP-712 fields.

---

## 1.3 Middleware layer

### `middleware/auth.js` (137 lines)
**Responsibility:** The **user-facing auth gate** (distinct from device auth).
- **`protect(req,res,next)` (`:13`)** — the core. Token source precedence:
  `Authorization: Bearer …` header, else `accessToken` cookie (`:16–20`).
  `verifyAccessToken()` → load `User` (projecting hidden security fields) →
  **token-version revocation check** (`:45–51`: `decoded.version` must equal
  `user.accessTokenVersion`, else 401 `TOKEN_REVOKED`) → reject soft-deleted
  (`ACCOUNT_DEACTIVATED`) → reject banned (`ACCOUNT_BANNED`) → map
  `TokenExpiredError`/`JsonWebTokenError` to typed 401s.
- `authorize(...roles)` (`:94`) — legacy role gate (superseded by
  `requirePermission`).
- `requireEmailVerified` (`:104`) — 403 `EMAIL_NOT_VERIFIED` unless verified
  (skips for admin/moderator).
- `requirePasswordCurrent` (`:124`) — 403 `PASSWORD_RESET_REQUIRED` if
  `mustChangePassword`.

### `middleware/csrf.js` (77 lines)
Double-submit-cookie CSRF, **only for cookie-authed clients** (Bearer clients
are immune). `issueCsrfToken` (`:38`) sets the cookie (`httpOnly:false` so the
SPA can read it) and echoes it on the `X-CSRF-Token` response header for
cross-origin SPAs. `csrfProtection` (`:59`) passes safe methods / Bearer /
exempt paths (`/auth/login`, `/auth/register`, `/auth/refresh`, `/telemetry`),
else compares cookie token to header token (mismatch → 403 `CSRF_INVALID`).

### `middleware/rateLimit.js` (184 lines)
Factory producing Redis-or-memory rate limiters.
- `createRateLimiter({windowMs, maxRequests, message})` (`:14`) — prefers Redis
  (Lua `INCR`+`PEXPIRE` script `:6`), degrades to in-memory on Redis failure.
  On breach: lazily requires `auditService`, logs `API_RATE_LIMITED`, sets
  `Retry-After`, returns 429.
- **11 preset factories** (`:83–163`): chat (20/60s), report (5/1h), admin,
  auth, forecast (30/15m), anomaly, profile, buy-order (20/1h), preview,
  general API (120/60s), rating (10/1h). Each is env-tunable.

### `middleware/rateLimitMemory.js` (70 lines)
Bounded in-memory fallback store (only when Redis down). `MAX_KEYS=10000`,
periodic cleanup, `.unref()`'d interval. `warnProductionFallback()` (`:6`)
emits a one-time warning in prod.

### `middleware/correlationId.js` (49 lines)
For each request: resolve a **sanitized** correlation id + W3C `traceparent`,
echo on the response, and bind into `AsyncLocalStorage` (`requestContext.run`)
so every log line + outbound fetch carries them. Inbound headers are never
trusted verbatim (log-forging / header-injection defense).

### `middleware/logger.js` (60 lines)
One structured JSON log per finished request. `redactQueryString` (`:18`)
scrubs sensitive query keys (`token`, `password`, `api_key`, `captcha`, …)
before logging.

### `middleware/errorHandler.js` (79 lines)
The **last** middleware — normalizes every error into a consistent JSON
envelope. `mapKnownError` (`:3`) handles: body-parser `entity.parse.failed`
→ 400 `INVALID_JSON`; Mongoose `ValidationError`/`CastError` → 400; Mongo
duplicate-key (`11000`) → 409 `DUPLICATE_KEY`; JWT errors → 401. In prod,
5xx errors are masked to a generic message (no stack/detail leak).

### `middleware/metricsMiddleware.js` (21 lines)
Records per-request count + latency into the Prometheus registry on response
finish (`recordHttpRequest`). `normalizeRoute` collapses parametric paths to
cardinality-bounded labels.

### `middleware/deviceAuth.js` (126 lines)
IoT device auth via admin-issued credentials (`x-device-id` / `x-api-key`).
- bcrypt constant-time compare; **uniform 401 body** for every failure type
  (no device-enumeration side-channel).
- On success sets `req.device` + `req.node`. If node `status !== 'active'`
  → 403 `NODE_INACTIVE` (the "ingestion rejects inactive nodes" guardrail).
- Every failure audit-logged via `auditService` (`DEVICE_AUTH_FAILED`).

### `middleware/deviceRateLimit.js` (100 lines)
Per-device tier-driven limiter (key = `req.device.deviceId`). Tiers:
`standard` (60/60s), `high` (300/60s), `unrestricted` (no-op). Redis-or-memory.

### `middleware/captchaVerify.js` (144 lines)
Multi-provider CAPTCHA (reCAPTCHA v2/v3, hCaptcha, Turnstile). `getProvider()`
(`:20`) auto-detects from env. `verifyToken` (`:36`) POSTs to the provider.
`captchaVerify` (`:87`) requires the token, checks reCAPTCHA v3 score
(`RECAPTCHA_MIN_SCORE`, default 0.5). Optional in dev, required in prod.

### `middleware/requirePermission.js` (50 lines)
The **modern capability-based RBAC gate**. `requirePermission(...perms)`
(`:20`) grants access if the caller's role holds any permission (OR-semantics);
wildcard (admin) always passes; unknown roles fail-closed. Throws at
registration time if no perms supplied (catches misconfigured routes).
Resource-scoping (own/zone) is **still** enforced in the controller layer.

### `middleware/ratingGuards.js` (24 lines)
Validates a reputation-rating body, attaches `req.rating`.

### `middleware/simulatorLockdown.js` (29 lines)
Blocks simulator **mutation** endpoints in production real-data mode
(`ingestionMode.isSimulatorLockedDown()` → 403 `SIMULATOR_LOCKED_DOWN`). Read
endpoints stay open.

---

## 1.4 Auth & RBAC

### `auth/roles.js` (131 lines)
Single source of truth for app-identity roles + the role→capability map.
- `ROLES = {consumer, prosumer, grid_operator, admin, moderator}`.
- `ROLE_PERMISSIONS` (`:60`): consumer/prosumer get node CRUD (own) + trade +
  carbon transfer; grid_operator gets **zone-scoped read only**; moderator gets
  read-all + admin access + user management; **admin = `'*'` wildcard** (every
  permission automatically).
- `LEGACY_ROLE_MAP = {user → consumer}` for migration.
- `hasPermission(role, perm)` (`:111`) — wildcard pass, unknown fail-closed.
- `PRIVILEGED_ROLES = {admin, moderator}` — grid_operator is intentionally
  **not** privileged (its visibility is zone-scoped, not global).

### `auth/permissions.js` (35 lines)
Flat catalog of permission strings in `resource:action[:scope]` form:
`NODES_CREATE`, `NODES_READ_OWN/_ZONE/_ALL`, `NODES_WRITE_OWN`,
`NODES_DELETE_OWN`, `TRADES_EXECUTE`, `TRADES_READ_ALL`, `CARBON_AWARD`,
`CARBON_TRANSFER`, `ANALYTICS_READ_GLOBAL/_ZONE`, `ADMIN_ACCESS`,
`USERS_MANAGE`, `SYSTEM_SYNC`.

---

## 1.5 Models (Mongoose)

`backend/models/` holds 28 schemas. Highlights:

| Model | Purpose | Notable fields / indexes |
|-------|---------|--------------------------|
| `User.js` (209) | Accounts | bcrypt password (`select:false`), `walletAddress` unique+sparse (EIP-712 linked), `role`, `accessTokenVersion`/`refreshTokenVersion` (revocation), `loginAttempts`/`lockUntil` (lockout), `isEmailVerified`, `mustChangePassword`, `assignedZoneIds` (grid_operator zones), `isBanned`/`deletedAt`. Virtual `isLocked`. `generateEmailVerificationToken`. |
| `EnergyNode.js` | A metering node | ownerId, nodeType/sourceType/status, location, maxCapacityKw, ingestionMode, operators[] (delegation). |
| `EnergyReading.js` | Raw telemetry | nodeId, energyGenerated, energyConsumed, timestamp, source, providerKey, deviceId, meta. |
| `EnergyReadingTimeseries.js` | Mongo time-series collection (`energyreadings_ts`) | timeField timestamp, metaField meta, TTL. |
| `EnergyReadingHourly.js` | Hourly rollups | nodeId, hour, sums, peak, count. |
| `DeviceCredential.js` | Device API keys | deviceId, hashed apiKey, nodeId, rateLimitTier, status, failedAttempts, apiKeyVersion. |
| `Trade.js` | Off-chain mirror of on-chain trades | txHash, logIndex (unique together), eventType (`listed`/`purchased`/`cancelled`/`expired`), listingId, seller, buyer, energyAmount, price (string for precision), blockNumber, timestamp. |
| `Escrow.js` | Mirror of EnergyEscrow | escrowId, buyer, seller, amount, state, listingId, createdAt/deliveredAt. |
| `Settlement.js` | Trade settlement + verification | txHash, logIndex, listingId, buyer, seller, onChainStatus, confirmations, verificationStatus (`pending`/`verified`/`mismatch`/`disputed`), mismatchFlag, evidenceHash, deltaPct. |
| `Dispute.js` | Mirror of dispute state | disputeId, escrowId, buyer, seller, amount, evidenceHash, resolved, outcome. |
| `BuyOrder.js` | Off-chain EIP-712 buy intents | bidder, walletAddress, signature, typedData, nonce, expiresAt, sourceIp/sourceUserAgent (`select:false`). |
| `ListingIntent.js` | Off-chain EIP-712 listing intents (auto-trading) | policyId, signer, bounds, nonce, status (`active`/`consumed`/`revoked`/`stale`), linkedListingTxHash. |
| `AutoListingPolicy.js` | Per-(user,node) auto-listing policy | one per pair (compound unique index), enabled, config, intentRef. |
| `Retirement.js` | Indexed `Retired` events | chainId, contractAddress, retirementId, account, amount, certificateUri, initiator. |
| `CreditAward.js` | Mint-to-earn awards | nodeId, recipient, kwh, ccAmount, evidenceHash (idempotency), status (`pending`/`awarded`/`failed`). |
| `BridgeTransfer.js` | Indexed bridge events | direction, chainId, nonce (idempotency), sender/recipient, amount. |
| `Rating.js` / `Reputation.js` | Reputation | Rating: rater/ratedWallet/listingId/tradeTxHash/score/comment. Reputation: wallet, avgScore, distribution, disputeRate, verifiedDeliveryRate. |
| `Notification.js` | User notifications | userId, type, title, body, data, readAt, dismissedAt. |
| `AuditLog.js` | Hash-chained audit log | actor, action, resourceType/Id, metadata, ip, userAgent, severity, prevHash, hash. |
| `ReportJob.js` | Async PDF report jobs | userId, period, scope, delivery, status, error. |
| `AnomalyEvent.js` | Flagged anomalous readings | userId, nodeId, timestamp, score, reasonCodes. |
| `GridZone.js` / `PublicGridSource.js` / `AutoTradingConfig.js` / `SimulatorConfig.js` / `SyncState.js` / `IngestionError.js` | Configuration + operational state. |

---

## 1.6 Routes

### `routes/v1.js` (41 lines)
The **single aggregator** mounted at `/api/v1`. Composes the user guard chain
`[protect, requirePasswordCurrent, requireEmailVerified]` + `apiRateLimit`
and delegates to feature routers (`nodes`, `readings`, `forecast`, `anomaly`,
`analytics`, `trades`, `marketplace`, `escrow`, `disputes`, `settlements`,
`carbon`, `pricing`, `trading`, `assistant`). `/admin` needs
`authorize('admin','moderator')`. `/telemetry` is **outside** the user guard
(device auth instead).

### Feature routers (`routes/*.js`)
| File | Mount | Guard notes |
|------|-------|-------------|
| `auth.js` (87) | `/auth` | Per-endpoint rate limiters; `captchaVerify` on register; EIP-712 wallet linking (`/wallet/challenge`, `/link`, `/unlink`) |
| `nodes.js` (34) | `/nodes` | `/map` first; POST needs `NODES_CREATE`; read perms vary by scope |
| `readings.js` (13) | `/readings` | POST admin-only |
| `forecast.js` (11) | `/forecast` | `forecastLimiter` |
| `anomaly.js` (13) | `/anomaly` | `anomalyLimiter`; IDOR guard in controller |
| `analytics.js` (37) | `/analytics` | Energy/nodes/trades behind `ANALYTICS_READ_GLOBAL`; carbon wallet-scoped |
| `trades.js` (19) | `/trades` | `/recent` anonymized ticker; `/history/sync` admin |
| `marketplace.js` (81) | `/marketplace` | Order book + buy-orders + trade history + ratings + settlements (all hard wallet-scoped) |
| `escrow.js` (12) | `/escrow` | list/get only |
| `disputes.js` (23) | `/disputes` | evidence POST (hourly limiter) + resolve (admin) |
| `settlements.js` (25) | `/settlements` | `/verify` tighter 10/min limiter |
| `carbon.js` (32) | `/carbon` | Reads; `/retirements` + `/bridge/index` are client-signs/index (idempotent); `/award` needs `CARBON_AWARD` |
| `pricing.js` (17) | `/pricing` | `/curve` + `/recommendations` |
| `autoPolicy.js` (52) | `/trading` | EIP-712 domain + policy CRUD + signed-intent enable/disable + notifications |
| `assistant.js` (16) | `/assistant` | `/chat`, `/report`, `/report/preview` |
| `telemetry.js` (34) | `/telemetry` | **Device auth**, 4KB cap, outside user guard |
| `metrics.js` (72) | `/metrics` | token-gated (`safeEqual` constant-time compare) |
| `admin.js` (117) | `/admin` | Full admin surface; `authorize('admin','moderator')` + admin-mutations |

---

## 1.7 Controllers

Controllers are thin HTTP adapters. Key ones:

### `controllers/authController.js` (610 lines)
- `register` (`:71`) — dummy bcrypt compare on existing email (timing uniform /
  anti-enumeration), hashes password, mints verification token, sends email
  non-blocking.
- `login` (`:149`) — audits `AUTH_FAILED` on miss; enforces `deletedAt`,
  `isBanned`, `isLocked`; lazy weak-password detection flips
  `mustChangePassword`.
- `refresh` (`:234`) — compares `refreshTokenVersion`; **rotates version
  atomically** via `findOneAndUpdate` with version filter so a stolen/reused
  token is rejected (`REFRESH_TOKEN_REUSED`).
- `updateProfile` (`:306`) — **forbids free-text `walletAddress` change** (must
  use the signed `/auth/wallet/link` flow → `WALLET_LINK_REQUIRED`).
- `updatePassword` (`:384`) — requires `currentPassword`; bumps BOTH token
  versions (invalidates all sessions).
- Helpers: `setAuthCookies` (httpOnly, secure in prod, refresh scoped to
  `/api/v1/auth`), `toUserResponse` (PII-safe).

### `controllers/marketplaceController.js` (128 lines)
Thin pass-through to `marketplaceService` / `buyOrderService`. `parseSeller`
(`:7`) validates `0x…{40}`. No mutation here.

### `controllers/tradesController.js` (123 lines)
`resolveWalletScope` (`:7`) — privileged (admin/mod) may pass any wallet;
everyone else is **hard-scoped to their own linked wallet** (400 if none, 403 on
mismatch). `getRecent` (`:98`) returns the global **anonymized** ticker
(`limit` 1–100, `eventType` whitelisted, sanitized via `shapeTradeTickerItem`).

### `controllers/forecastController.js` (450 lines)
Proxy to the AI service with strict validation + **node-ownership
enforcement** (`assertNodeOwnership` before any AI call). `INTERNAL_SERVICE_API_KEY`
mandatory in prod. `resolveBatchNodeIds` (`:156`) — admins target any/all
nodes; others resolve to owned. Three branches in `getForecast` (`:236`):
multi-node batch, single node, or aggregate (non-privileged scoped to own).

### `controllers/anomalyController.js` (324 lines)
Proxy to ML anomaly scoring. `OBJECT_ID_RE` (`:34`) blocks NoSQL-injection
object payloads. `persistFlagged` (`:132`) — idempotent bulk upsert keyed by
`(userId, nodeId, timestamp, reasonCode)`, capped. IDOR guard: non-privileged
may only score owned nodes.

### `controllers/carbonController.js` (177 lines)
- `indexRetirement` (`:36`) — **client signs the burn**, backend indexes the
  receipt via `retirementService.indexRetirementTx`; foreign-wallet records
  rejected for non-admins.
- `awardCredits` (`:143`) — admin mint-to-earn; idempotent (200 on replay).

### `controllers/escrowController.js` (70 lines)
Read-only; `getEscrow` best-effort chain refresh before the DB read so terminal
states are never stale; party-wallet authorization.

### `controllers/disputeController.js` (127 lines)
`submitEvidence` (`:58`) — only buyer/seller may attach evidence; rejects
resolved disputes. `resolveDispute` (`:110`) — admin/mod; **submits the on-chain
resolution tx** via `disputeService.resolveDispute`.

### `controllers/settlementController.js` (161 lines)
`listSettlements` (`:17`) — non-admins hard-scoped via
`$or:[{buyer},{seller}]`. `verifySettlement` (`:91`) →
`settlementVerificationService.verifyPurchase`. `triggerReconcile` (`:149`) — admin.

### `controllers/pricingController.js` (179 lines)
`resolveNodeId` (`:27`) — ownership scoping (only node owner or admin). Aggregate
curve open to all. `getRecommendations` (`:112`) — strict ownership; recommendation
carries a short `expiresAt` TTL.

### `controllers/nodeController.js` (255 lines)
CRUD + map with Module 8.x RBAC. `assertNodeTypeAllowedForRole` (a consumer
can't create a producer). `resolveCreateOwner` prevents createNode IDOR.
`assertNodeAccessAsync` BEFORE content validation (prevents state-inference).
`getNodesForMap` (`:212`) — RBAC-scoped, PII-free, bounded by `MAX_MAP_NODES`.

### `controllers/assistantController.js` (188 lines)
GenAI orchestrator: `classifyIntent` → `retrieveForIntent` (ownership
re-checked) → doc chunks → `genaiClient.postChat`. Sanitizes retrieved data to
8KB. Fire-and-forget session snapshot stores **only metadata** (never
message/reply).

### `controllers/reportController.js` (236 lines)
`generateReport` (`:95`) — builds metrics → `postNarrate` → PDF (pdfkit) →
email; on send failure persists `failed` ReportJob + **falls back to chat
delivery**; always audit-logs.

### `controllers/walletLinkController.js` (123 lines)
EIP-712 flow. `unlinkWallet` (`:76`) **requires password re-auth** so a stolen
access token can't unlink/swap the victim's wallet; bumps `accessTokenVersion`.

### `controllers/marketplaceSettlementController.js` (120 lines)
Buyer/seller-facing settlement surface — **always hard-scoped to the caller's
wallet** (no admin/global path). `enrich` (`:24`) attaches lifecycle timeline +
escrow state.

### `controllers/marketplaceTradeHistoryController.js` (195 lines)
`resolveMarketplaceTradeScope` (`:40`) — non-privileged must query own wallet or
a specific listingId. `getMarketTape` (`:110`) fully anonymized via
`anonymizeWallet`. `getAggregatedTrades` (`:122`) rolls up fills-per-listing.

### `controllers/autoPolicyController.js` (476 lines)
Auto-listing policy CRUD + EIP-712 enable/disable. `getEip712Domain` (`:73`)
returns canonical typed-data (frontend signs the EXACT structure).
`enablePolicy` (`:254`) verifies signer equals wallet; `listingIntentService.createVerifiedIntent`.

---

## 1.8 Services

The largest folder. Grouped by domain:

### Trading / marketplace
- **`marketplaceService.js` (482)** — active order book + depth ladder,
  multi-layer caching. `getActiveOrders` (`:83`) via `getCachedActiveListings`
  (avoids O(n) RPC scan). `getMarketDepth` (`:148`) **degrades to zero-depth on
  RPC outage** (never throws). `aggregateAsks` (`:241`) pure price-level ladder.
  `invalidateOrderBookDepthCache` (`:367`) deletes only tracked keys (no
  Redis `KEYS`/`SCAN` — event-loop safe).
- **`buyOrderService.js` (503)** — off-chain EIP-712 buy intents.
  `buildTypedData` (`:79`), `recoverSigner` (`:126`), monotonic per-user nonce
  replay protection (`:253`), `sanitizeForOwner` strips signatures/IP/UA,
  `getActiveBuyDepth` (`:422`) aggregates by price level **without per-wallet
  data**.
- **`listingCache.js` (66)** — 30s TTL cache (memory + Redis).
- **`tradeHistoryService.js` (268)** — query builder + summary aggregator +
  ticker shaping. `shapeTradeTickerItem` (`:221`) drops items with no valid
  counterparty AND no stable txHash:logIndex.
- **`reputationService.js` (369)** — ratings + aggregation. `canRate` (`:101`)
  requires a **verified Settlement** between rater (buyer) and rated (seller).
  `recomputeReputation` (`:204`) folds verified/disputed counts into reputation.
- **`tradeAggregationService.js` (190)** — per-listing "legs" aggregation.

### Blockchain
- **`blockchainService.js` (404)** — ethers v6 wrappers over all 6 contracts.
  Read via `JsonRpcProvider`; write via `NonceManager`-wrapped `Wallet`.
  ABI loading prefers compiled artifacts, falls back to bundled constants.
  `getActiveListings` (`:195`) chunks RPC, **drops expired-unpruned listings**.
  `mintTokens`, `listEnergy`/`listEnergyWithExpiry`, `purchaseEnergy`/
  `purchaseEnergyPartial`, `approveTrading`, `pauseMarketplace`/
  `unpauseMarketplace`/`isMarketplacePaused`.
- **`blockchainSyncService.js` (1030)** — the indexer. `syncBlockchainTrades`
  (`:408`) singleton-locked, chunked, idempotent upsert keyed `(txHash,
  logIndex)`. `fetchLogsForRange` (`:129`) is **rate-limit aware**: distinguishes
  429/compute-units (backoff + retry SAME range) from oversized-range (split +
  recurse). Real-time listeners (`:668`) fire `emitTradeExecuted` for the live
  ticker. `getChainStatus` (`:628`) for the admin sync dashboard.
- **`bridgeService.js` (309)** — CarbonCreditBridge event indexing (lock/mint/
  return/release). Idempotent on `(chainId, contract, direction, nonce, logIndex)`.
- **`escrowService.js` (111)** — escrow mirror CRUD + `syncEscrowMirror` chain
  refresh.
- **`disputeService.js` (190)** — `resolveDispute` (`:106`) **submits the on-chain
  `contract.resolve(...)` tx via the relayer** (must hold `ARBITER_ROLE`).
- **`retirementService.js` (187)** — indexes `Retired` events; idempotent.
- **`mintEligibilityService.js` (173)** — mint-to-earn: `evaluateEligibility`
  (per-node 24h cap), `awardCredits` **idempotent on `evidenceHash`**.

### Settlement
- **`settlementVerificationService.js` (336)** — decodes a purchase receipt and
  asserts it matches the on-chain listing struct. Enforces **confirmation depth**
  (`SETTLEMENT_MIN_CONFIRMATIONS`, default 12) so a reorg can't flip
  verification. Decodes the `EnergyPurchased` log **only if emitted by the
  configured `ENERGY_TRADING_ADDRESS`** (prevents spoofing). Flags
  `LISTING_ID_MISMATCH`/`SELLER_MISMATCH`/`BUYER_EQUALS_SELLER`. Triggers
  `reputationService.recomputeReputation(seller)` asynchronously.
- **`settlementLifecycleService.js` (127)** — **pure** derivation of the
  user-facing lifecycle. `computeLifecycle` (`:57`) terminal-first precedence:
  `disputed > refunded > released > mismatch > readings_verified >
  on_chain_confirmed > pending`. `buildTimeline` (`:91`) for UI steps.
- **`reconciliationService.js` (418)** — compares on-chain delivered energy vs
  off-chain metered generation (trapezoidal integration). Flags
  `OVER_DELIVERY`/`UNDER_DELIVERY`/`READING_GAP`. **AI anomaly tie-in**: mismatch
  + anomaly score ≥ `SETTLEMENT_AUTOFLAG_SCORE` (0.8) auto-escalates to
  `disputed`. `emitSettlementEvent` (`:294`) emits **only to buyer/seller wallet
  rooms** (Module 9.6 — never a global broadcast).

### Pricing
- **`pricing/pricingEngine.js` (445)** — **read-only** kWh price curve from
  forecast + market. Pure math: `computeSurplusRatio` (`:56`),
  `resolveMarketAnchor` (`:91` — blends historical avg with live order-book avg,
  small weight so an outlier can't dominate), `computePricePoint` (`:111`).
  `getPricingCurve` (`:356`) Redis-cached (5-min). Rejects NaN/negative; clamps
  to `[floor, ceiling]`.
- **`pricing/surplusService.js` (234)** — surplus detection + listing
  recommendation. `buildRecommendation` (`:159`) eligibility gates + short TTL.
- **`pricing/listingIntentService.js` (441)** — off-chain EIP-712 listing intent
  (authority for auto-policy). `verifyIntentSignature` (`:153`),
  `createVerifiedIntent` (`:218` — stale-nonce check). `linkOnChainListing`
  (`:355`) — **post-list validation** with atomic `status:'active'` filter
  (prevents double-link).
- **`pricing/autoTradingService.js` (651)** — the matcher (v1 notify-only).
  `isAutoTradingActive` (`:43`) env flag AND DB `paused` (fail-closed on error).
  Redis quota/idempotency. `evaluatePolicy` (`:313`) checks stale-listing
  detection. `evaluateAll` (`:448`) fail-closed on kill switch / Redis outage.

### Ingestion
- **`ingestion/telemetryService.js` (145)** — unified pipeline. 6-stage:
  validate → device→node binding check (anti-impersonation) → node active →
  capacity → dedup → `readingService.ingestReading` tagged `source:'device'`.
- **`ingestion/telemetrySchema.js` (146)** — `validateEnvelope` (finite
  non-negative, sanity ceiling 1e9, **clock-skew rejection** ±5min).
- **`ingestion/dedup.js` (63)** — Redis `SET NX EX 86400` fast path + in-memory
  LRU fallback (50k cap).
- **`ingestion/backfillService.js` (274)** — admin historical import (JSON/CSV);
  simulated-in-production guard; dry-run support.
- **`ingestion/ingestionMetrics.js` (245)** — counters + dead-letter
  persistence (deduped + rate-limited).
- **`mqtt/mqttIngestionService.js` (229)** — optional TLS-only MQTT subscriber.
  Lazy `require('mqtt')`. 4KB payload cap. TTL device cache.
- **`timeseries/timeseriesSetup.js` (171)** — idempotent bootstrap of the
  time-series collection + indexes (never throws).
- **`timeseries/timeseriesWriter.js` (82)** — dual-write bridge. `sanitizeMeta`
  enforces a **whitelist meta** (no PII in meta). TS failure is non-fatal.

### Cross-cutting
- **`healthService.js` (744)** — aggregated platform health. `toPublicStatus`
  (`:204`) **strict whitelist** (no hosts/ports/versions/errors).
  `isReadyForTraffic` (`:162`) — 503 only when Mongo/backend critical down.
  `maskUrlHost`/`scrubMessage` prevent host/IP leak.
- **`socketBroadcastService.js` (269)** — emission layer with debounced
  analytics. `emitSettlementEvent` (`:214`) emits **only to wallet rooms** (never
  global).
- **`auditService.js` (104)** — hash-chained append-only audit log
  (`computeHash` chains off `getLastHash`).
- **`genaiClient.js` (117)** — outbound HTTP client to genai-service with the
  `x-internal-api-key` header; scrubs messages; retries once on 429.
  `postNarrate`, `postChat`, `fetchDocChunks`, `reindexAssistantDocs`.
- **`retrievalService.js` (245)** + **`assistantRetrievers.js` (395)** —
  intent→retriever dispatch; every query restricted to owned nodes; ObjectIds
  never returned. `computeBillAnalysis` (`:99`) pure period-over-period.
- **`intentClassifier.js` (140)** — regex intent classification.
- **`assistantSessionStore.js` (84)** — Redis session snapshots (metadata only).
- **`reportService.js` (221)** + **`pdfReportService.js` (113)** — report metric
  builders + pdfkit generation.
- **`walletLinkService.js` (346)** — EIP-712 core. `linkWallet` (`:232`)
  **rebuilds typed-data from the SERVER-STORED challenge** (client may only
  supply `{wallet, signature}`); **atomic claim** via `findOneAndUpdate` with
  nonce filter (race-safe).
- **`deviceService.js` (505)** — bcrypt-hashed device keys, brute-force lockout,
  anti-enumeration (constant `DUMMY_HASH`), provisioning/rotation/revocation.
- **`notificationService.js` (157)** — durable notifications (persist + socket +
  optional email).
- **`emailService.js` (312)** — multi-provider (Brevo HTTP API > Resend > SMTP).
  `sendEmailWithRetry` bounded backoff.
- **`nodeMapService.js` (140)** — `buildMapFilter` (RBAC scoping),
  `shapeMapNode` (PII-stripped).
- **`readingService.js` (208)** — **single ingest entry point** shared by all
  sources. Tags `source` + provenance, dual-writes, emits socket.
- **Analytics** (`services/analytics/*`): `flowService.js` (Sankey, NoSQL-injection-safe),
  `summaryService.js`, `tradeAnalytics.js`, `energyAnalytics.js`,
  `carbonAnalytics.js`, `timeseriesAnalytics.js` (reads from secondaries),
  `autoTradingAnalytics.js` (matcher quality: recommendation→consumed conversion,
  price accuracy, listing-volume-anomaly fraud guard).

---

## 1.9 Workers

All four workers share a pattern: `setInterval` loop, `running` re-entrancy
guard, staggered bootstrap, `start()/stop()/tick()/getStatus()`, idempotent +
fail-closed.

- **`workers/rollupWorker.js` (169)** — Sub-module 1.3.6. Materializes
  time-series buckets into hourly rollups. Idempotent via `{nodeId, hour}` upsert;
  reads from secondaries.
- **`workers/publicGridPoller.js` (134)** — Sub-module 1.5.3. Single 60s scan
  polling all due enabled `PublicGridSource`s (per-source intervals honored on
  one loop). Sequential polling to be a good citizen.
- **`workers/autoListingMatcher.js` (89)** — Sub-module 2.3.3. Runs
  `autoTradingService.evaluateAll()` (default 15 min). Fail-closed on kill
  switch + Redis outage.
- **`workers/reconciliationWorker.js` (69)** — Module 5.2.5. Backfills
  Settlements + reconciles against meter telemetry (default 5 min).

---

## 1.10 Simulator subsystem

`backend/services/simulator/` + `simulatorManager.js` + CLI scripts.

- **`profiles.js` (185)** — capacity tables + diurnal curve math (Gaussian solar
  peaking at 13h, wind with gust/turbulence, home/industry load factors). The
  physics model.
- **`nodeState.js` (111)** — per-node EMA smoother (`alpha=0.32`) so readings
  evolve gradually; tracks active failure modes (`offline`/`reduced_output`/
  `spike`/`intermittent`) with per-tick countdown.
- **`runner.js` (175)** — `SimulatorRunner` loads nodes (DB or MOCK fallback),
  picks a transport (REST/socket/injected), emits jittered readings on a timer.
- **`configStore.js` (91)** — in-memory cache of `SimulatorConfig` + hardcoded
  defaults so the CLI works without DB.
- **`transports.js` (136)** — REST + Socket.IO transports (offline buffering).
- **`simulatorManager.js` (152)** — in-process embedded simulator. Respects the
  ingestion-mode lockdown (`isEmbeddedEnabled` requires non-prod + simulator
  allowed). In-process transport ingests via `readingService`.
- **`simulate_nodes.js` / `simulator.js`** — standalone CLI entrypoints
  (socket / REST). Hard-abort in production.

---

## 1.11 Public-grid ingestion

`backend/services/publicGrid/`.

- **`httpClient.js` (120)** — **SSRF-guarded** outbound client. `assertSafeUrl`
  (`:22`): HTTPS-only, host allowlist (exact/parent-domain), rejects embedded
  credentials, blocks private/reserved addresses (`isPrivateHost`).
  `redirect:'error'` so a 3xx to internal can't bypass. Bounded `AbortController`
  timeout.
- **`adapters/baseAdapter.js` (135)** — shared input hygiene. `normalizeReading`
  (`:61`) single chokepoint rejecting NO_DATA/OUT_OF_RANGE/INVALID_TIMESTAMP/
  FUTURE_DATED/MISSING_EXTERNAL_ID. `buildExternalReadingId` secret-free dedup id.
- **`adapters/registry.js` (74)** — `providerKey → adapter` map: `smard_de`,
  `cea_in`, `eia_us`, `fingrid_fi`, `entsoe_eu`.
- **`adapters/*.js`** — one per provider: `smardAdapter` (Germany, no key),
  `ceaAdapter` (India, no key), `eiaAdapter` (USA, `EIA_API_KEY` via header),
  `fingridAdapter` (Finland, `FINGRID_API_KEY`), `entsoeAdapter` (Europe,
  `ENTSOE_API_TOKEN`, XML parsed with a focused regex — no XML dependency).
- **`publicGridService.js` (425)** — orchestrator. Circuit breaker (state
  persisted on `PublicGridSource` so a restart can't reset defenses).
  `pollSource` (`:156`) never throws; per-reading ceiling + dedup +
  `readingService.ingestReading({source:'public_api'})`.

---

## 1.12 Socket layer

- **`socket/index.js` (87)** — creates the `Server`, enforces JWT handshake
  auth (`io.use`), **token-version revocation check** in the handshake
  (`:57–59`), caches user lookups (TTL 60s), exposes `io` to Express + the
  broadcast service, registers handlers. All errors collapse to
  `Authentication failed` (no reason leak).
- **`socket/registerHandlers.js` (31)** — on connection, joins rooms
  (`authenticated`, `user:<id>`, `role:<role>`, `wallet:<addr>`) + registers
  the simulate handler.
- **`socket/events.js` (23)** — canonical event-name catalog. SERVER events:
  `newReading`, `analyticsUpdate`, `blockchainEvent`, `notification`,
  `settlementVerified`, `settlementMismatch`, `orderbookUpdate`, `tradeExecuted`.
- **`socket/handlers/simulateReading.js` (15)** — dual gate (`ALLOW_SOCKET_SIMULATION`
  AND admin) for the `simulateReading` event.

---

## 1.13 Utils

- **`logger.js` (88)** — JSON logger stamping every line with correlation id +
  traceparent from `AsyncLocalStorage`. `logBackgroundError` for non-fatal
  background failures.
- **`fetchWithTimeout.js` (75)** — `fetch` wrapper with `AbortController` +
  sanitized `x-request-id`/`traceparent` header propagation.
- **`correlation.js` (118)** — correlation id + W3C traceparent sanitize/
  resolve/generate (never trusts inbound headers).
- **`scrubLog.js`** — strips internal hostnames/IPs from messages.
- **`validators.js`** — wallet/email/password/price validators.
- **`tokens.js`** — JWT sign/verify helpers.
- **`paginate.js` / `periodHelpers.js` / `apiError.js` / `asyncHandler.js`** —
  shared HTTP helpers.
- **`nodeOwnership.js`** — `assertNodeAccessAsync`, `buildNodeAccessFilter`
  (zone + delegation aware) — the resource-scoping core.
- **`mqttDeviceCache.js`** — TTL cache for MQTT device→node resolution.
- **`forecastMerge.js`** — forecast response merging helpers.

---

## 1.14 Admin controllers & routes

### `routes/admin.js` (117 lines)
Mounts the whole admin API under `/api/v1/admin`. `authorize('admin','moderator')`
globally + `createAdminRateLimiter()`. Mutations need `authorize('admin')`
(admin-only). Mounts sub-routers: `/devices`, `/models`, `/public-grid-sources`,
`/auto-trading`, `/zones`, plus inline simulator/ingestion/marketplace/
assistant/settlement surfaces.

### Admin controllers (`controllers/admin/`)
| File | Purpose |
|------|---------|
| `adminUserController.js` (286) | list/get/setRole (**cannot demote last active admin**), ban/unban/delete (soft). |
| `adminNodeController.js` (234) | node CRUD with enum allowlists; `cascade:true` deletes readings. |
| `adminZoneController.js` (211) | grid-zone CRUD + `assignUserZones` (grid_operator only). |
| `adminSettlementController.js` (162) | settlement queue; `overrideStatus` allowlisted targets (`pending/verified/mismatch/disputed` — escrow released/refunded **never** overridable). |
| `adminMarketplaceController.js` (85) | emergency stop (`pauseMarketplace`). |
| `adminAutoTradingController.js` (142) | kill switch + `runOnce`. |
| `adminPublicGridController.js` (351) | source CRUD + `pollNow` (bypasses breaker) + `resetCircuit`. |
| `adminIngestionController.js` (196) | unified ingestion dashboard + backfill. |
| `adminSimulatorController.js` (227) | config update (propagates to live runner) + restart/reset/preview. |
| `adminHealthController.js` (19) | delegates to `healthService`. |
| `adminModelController.js` (128) | thin proxy to AI service `/models`. |
| `adminReportJobController.js` (167) | retry failed email jobs. |
| `adminSyncController.js` (39) | sync status + force sync. |
| `adminAuditController.js` (47) | audit log query + chain integrity verify. |
| `adminTradeController.js` (82) | trade explorer. |
| `adminDeviceController.js` (263) | device CRUD + rotate-key + revoke. |
| `adminAssistantController.js` (39) | reindex RAG + analytics (counters only). |
| `adminTimeseriesController.js` (67) | TS status + trigger rollup. |

---

## 1.15 Scripts

`backend/scripts/`:
- **`utils/requireDevScript.js` (34)** — refuses ops scripts in prod without
  `ALLOW_DEV_SCRIPTS=true`.
- **`migrate-user-roles.js` (94)** — `user→consumer` migration (idempotent,
  prod-safe, dry-run default).
- **`migrate-wallet-address-index.js` (133)** — readies `walletAddress` for
  `unique+sparse`; dedups older claims (Module 8.4).
- **`promote-admin.js` (58)** — one-off admin bootstrap (dev-gated + bootstrap
  secret).
- **`test-mvp.js` (119)** — authenticated E2E workflow test (asserts admin
  analytics 403 for regular users).
- **`eval-assistant.js` (95)** — CI-safe assistant eval harness (7 golden
  questions, hybrid-retrieval guarantee).
- **`seed-public-grid-nodes.js` (167)** — creates `public_api` nodes + default
  sources (fail-closed `enabled:false`).
- **`migrate-readings-to-timeseries.js` (235)** — legacy → ts migration
  (refuses `--apply` without `APP_READ_ONLY_MODE=true`); verifies parity.
- **`backfill-audit-hashes.js` (117)** — links the hash chain onto pre-feature
  audit entries.
- **`testBlockchain.js` (48)** — dev-only smoke test.

---

## 1.16 Templates

### `templates/reportTemplate.js` (520 lines)
PDFKit layout primitives for the energy report (cover, executive summary,
grid-energy table, trading/profit table, node overview, forecast section,
disclaimer footer on every page). Uses `BRAND`/`FONTS` from `pdfConstants`.

---

# 2. AI Service Deep Dive

`ai_service/` — Python 3.11+, FastAPI, TensorFlow/Keras (LSTM), scikit-learn
(IsolationForest), Motor (async Mongo). Port `8000`.

## 2.1 Bootstrap

- **`main.py` (10)** — `app = create_app()`; runs uvicorn.
- **`app/factory.py` (86)** — builds the app: prod guards (internal key + CORS
  no `*`), request-logging middleware, CORS (`allow_credentials=False`), inline
  `internal_auth_middleware`, exception handlers, lifespan (loads forecast
  model eagerly; anomaly model optional/non-fatal). Mounts routers:
  `health, metrics, forecast, anomaly, models`. Disables `/docs`/`/redoc`/
  `/openapi.json` in prod.
- **`app/config.py` (171)** — frozen `Settings` dataclass (`@lru_cache`
  singleton). Artifacts (`model_dir`, `registry_dir`), anomaly knobs
  (`anomaly_score_threshold=0.7`, `zscore_cap=3.0`), lifecycle knobs (conformal
  alpha, retrain min days, drift window, A/B flags), multi-horizon horizons
  `(1,7,14,30)`, per-node settings (`node_min_history_days=60`).
- **`app/dependencies.py` (43)** — FastAPI DI providers (singletons:
  `ModelStore`, `AnomalyStore`, `ABTestService`, `DriftMonitor`; per-call:
  `ForecastService`, `AnomalyService`).

## 2.2 Cross-cutting infra

- **`app/internal_auth.py` (21)** — `internal_auth_response` exempts
  `/health*` + `/metrics`; 503 if no key; 401 on mismatch.
- **`app/middleware.py` (89)** — access log + correlation/trace + Prometheus
  (uses route template for cardinality; never logs query string).
- **`app/metrics.py` (275)** — dependency-free Prometheus text exposition;
  `/metrics` token-gated (`hmac.compare_digest` constant-time).
- **`app/logging_config.py` (258)** — structured JSON logging; strict W3C
  traceparent validation (log-forging defense).
- **`app/health_contract.py` (82)** — v1.0 cross-service health contract
  (worst-status rule; non-sensitive fields only).
- **`app/exceptions.py` (50)** — `AppError` hierarchy with HTTP mapping
  (`ModelUnavailableError`→503, `InsufficientDataError`→400,
  `BatchForecastError`→500).
- **`app/handlers/exceptions.py` (79)** — maps exceptions to `ErrorResponse`;
  only leaks `str(exc)` when debug AND not prod.

## 2.3 Routers

- **`routers/forecast.py` (239)** — `/forecast/`, `/forecast/confidence`,
  `/forecast/batch`. `_resolve_served_version` (`:63`) explicit version wins,
  else A/B deterministic per-node hash routing. Caching, fallback ladder,
  fire-and-forget A/B shadow logging.
- **`routers/anomaly.py` (94)** — `/anomaly/health`, `/anomaly/score`,
  `/anomaly/batch` (per-node errors become `skipped` entries).
- **`routers/models.py` (147)** — `/models/versions`, `/compare`, `/promote`,
  `/drift`. Strict version regex (path-traversal defense).
- **`routers/health.py` (91)** — `/health/live` (zero-I/O), `/health/ready`
  (503 if model missing and no fallback), `/health` (legacy keys preserved).
- **`routers/metrics.py` (49)** — Prometheus scrape (404 disabled, 401
  unauthorized, else `metrics.render()`).

## 2.4 Services

- **`services/forecast_service.py` (404)** — orchestrates inference. `_forecast_for_node`
  (`:192`): model resolution (version → per-node → global) → native horizon from
  metadata → multi-horizon single-pass (`predict_multi_horizon`) OR legacy
  recursive (`predict_future`) → confidence-band formatting (per-step conformal
  / legacy sqrt-scaled / heuristic). Runs TF in `asyncio.to_thread`.
- **`services/model_store.py` (165)** — loads/holds the LSTM + scaler. Dual-path
  (primary `model.keras`/`scaler.save` → registry LATEST). Version caching with
  backoff on failure.
- **`services/anomaly_service.py` (85)** + **`anomaly_store.py` (69)** —
  IsolationForest inference + load (failures never crash boot).
- **`services/ab_test_service.py` (137)** — A/B framework. `resolve_assignment`
  (`:65`) deterministic per-node SHA-256 hash. `log_comparison` into
  `modelcomparisons` collection.
- **`services/forecast_cache.py` (53)** — in-memory TTL cache (120s, 500 entries).
- **`services/drift_monitor.py` (182)** — compares recent realized errors vs
  training baseline; `reconcile_actuals` backfills MAPE for A/B docs.

## 2.5 ML models

- **`models/forecasting.py` (125)** — LSTM architecture: `LSTM(50) → Dropout →
  LSTM(50) → Dropout → Dense(horizon*2)`, `adam`+`mse`, `shuffle=False`.
  `predict_future` (`:71`) recursive single-step; `predict_multi_horizon` (`:96`)
  single forward pass. Both sanitize output (NaN→0, clip negatives).
- **`models/preprocessing.py` (218)** — leakage-safe: `_ensure_daily_index`,
  chronological `time_split`, **fit MinMaxScaler on train only**, `make_supervised`
  sliding windows, `prepare_for_prediction` (last `look_back` days).
- **`models/anomaly_detection.py` (133)** — IsolationForest. `_calibrate`
  (`:50`) robust 1st/99th percentile. `detect` (`:80`) flags when score ≥
  threshold OR any reason code fires.
- **`models/anomaly_preprocessing.py` (141)** — 10-feature frame
  (`gen_dod`, `cons_dod`, z-scores, rolling stds, net, jump ratios) +
  deterministic `reason_codes_for_row`.
- **`models/model_registry.py` (330)** — versioned filesystem registry.
  `_assert_safe_component` (`:15`) path-traversal defense. `save_bundle`/
  `load_bundle`/`list_versions`/`set_latest`/`get_latest`.
- **`models/node_model_registry.py` (229)** — per-node store
  (`nodes/<nodeId>/<version>/`). `load_node_bundle` (`:177`) per-node → global
  fallback.
- **`models/metrics.py` (176)** — pure MAPE/RMSE + **split-conformal margins**
  (single-step + multi-horizon per-step).

## 2.6 Data + training

- **`utils/database.py` (311)** — async Mongo (Motor). `get_historical_data`
  (`:136`): time-series path (raw `energyreadings_ts` + hourly rollups stitched
  for continuous daily history) OR legacy `energyreadings` aggregation OR dummy
  deterministic synthetic data. Reads the **same collection** the backend writes.
- **`train.py` (132)** — global LSTM training. **Prod guard: ignores `ECOPULSE_USE_DUMMY`
  in production.** `run_training` fetch → `build_training_matrices` → build_model →
  train → `evaluate_holdout` → `save_bundle` (promote optional).
- **`train_node.py` (229)** — per-node multi-horizon loop. Live data only; caps
  at 50/run.
- **`train_anomaly.py` (101)** — offline IsolationForest trainer.
- **`jobs/retrain_scheduler.py` (191)** — scheduled retraining: data-volume gate
  → train candidate (no promote) → promote only if MAPE improves ≥0.02 (or
  `force`) → optional per-node batch.

## 2.7 Current model state
`models/registry/lstm_energy_forecast/` has 2 versions, LATEST →
`20260527_130417`. That metadata has **no `metrics` block and no `horizon`** →
inference falls back to recursive `predict_future` + heuristic bands. No anomaly
model registered yet (`/anomaly/score` returns `MODEL_UNAVAILABLE` until
`train_anomaly.py` is run).

---

# 3. GenAI Service Deep Dive

`genai-service/` — Python 3.11+, FastAPI, Google Gemini SDK. Port `8001`.
Designed for **graceful degradation**: every Gemini path falls back to
deterministic templates.

## 3.1 Bootstrap
- **`main.py`** → `app/factory.py` (`:20`): prod guards (internal key + CORS no
  `*`), logging, request-logging middleware, CORS (`allow_credentials=False`),
  inline `internal_auth_middleware`, exception handlers (incl. a custom
  `RuntimeError` handler mapping "Gemini"/"not available" → **HTTP 503 with
  `fallback_available:True`**), startup `_init_services` constructing
  `LlmService` + `DocRagService` on `app.state`. Mounts `health, metrics,
  reports, assistant`.
- **`app/config.py`** — `genai_model="gemini-2.0-flash"`, `genai_max_tokens=800`,
  `genai_max_input_chars=12000`, `embedding_model="text-embedding-004"`.
  `genai_available` requires `genai_enabled` AND key.
- **`config.js` / `package.json`** — Node config shim + npm scripts wrapping the
  Python service (npm is just a task runner).

## 3.2 Routers
- **`routers/assistant.py`** — `POST /assistant/chat` (history trim, prompt
  build, history injection, fallback pre-compute, Gemini call or fallback,
  JSON parse, sanitize — strip tags/script, cap 4000 — demo vs live
  disclaimer). `POST /assistant/doc-chunks` (RAG retrieval). `POST /assistant/reindex`
  (admin-only RAG rebuild).
- **`routers/reports.py`** — `POST /reports/narrate` (strict no-hallucination
  prompt; JSON `{summary, highlights, disclaimer}`; fallback summary).
- **`routers/health.py`** — contract + legacy keys (`available`, `provider`,
  `model`, `fallbackMode`, `docs_loaded_count`).
- **`routers/metrics.py`** — token-gated Prometheus scrape.

## 3.3 Services
- **`services/llm_service.py` (158)** — Gemini wrapper. `complete` (truncate to
  `genai_max_input_chars`, cap output), `complete_json` (force JSON +
  Pydantic validation), `complete_with_fallback` (template on any error).
- **`services/prompts.py`** — all prompt engineering. `build_assistant_chat_prompt`
  (`:107`): strict anti-hallucination rules + **prompt-injection defense**
  (every `<<<...>>>` block treated as UNTRUSTED DATA, never instructions) +
  bill-analysis guidance. `build_report_narrate_prompt` (`:13`): cite-only
  numbers, mandatory demo disclaimer. `_extract_comparison_insights` (`:57`):
  pre-computed grounded bullets so the model cites real numbers. `trim_history`
  (`:189`): last 6 turns, 800 chars each.
- **`services/doc_rag_service.py`** — Doc-RAG over `DOCS_DIR` markdown.
  Security-hardened recursive walk (`_is_within_dir` rejects symlink escape).
  Embedding cache (disk, `chmod 0600`), cosine similarity search. `retrieveDocChunks`
  returns camelCase dicts.
- **`services/fallback_templates.py`** — deterministic Gemini-free templates
  for every retrieved-data shape (bill analysis, nodes, grid energy, trades,
  carbon, forecast).

## 3.4 How the backend calls it
`backend/services/genaiClient.js` POSTs with `x-internal-api-key`; scrubs
messages; retries once on 429. `postChat` → `/assistant/chat`, `postNarrate` →
`/reports/narrate`, `fetchDocChunks` → `/assistant/doc-chunks`.

---

# 4. Frontend Deep Dive

Split: `ecopulse/` (Vite host) + `frontend/` (shared sources, imported via
`../../frontend/...`). React 19, React Router 7, Tailwind 4, Recharts, Leaflet,
ethers v6, socket.io-client.

## 4.1 Host app (`ecopulse/`)
- **`src/main.jsx` (13)** — `createRoot(...).render(<StrictMode><AppErrorBoundary><App/></AppErrorBoundary></StrictMode>)`.
- **`src/App.jsx` (122)** — provider stack `ToastProvider → AuthProvider →
  BrowserRouter → WalletProvider → SocketProvider`. Routes: guest (`/login`,
  `/register`, `/verify-email` via `GuestRoute`), authenticated (`/*` via
  `ProtectedRoute` → `AuthenticatedApp`). Admin section role-gated
  (`['admin','moderator']`, distinct `AdminLayout`). Heavy routes lazy-loaded;
  `AssistantChat` suspended separately so it never blocks page load.
- **`vite.config.js` (58)** — `@tailwindcss/vite` + `@vitejs/plugin-react`;
  because `frontend/` is outside the project root, bare specifiers are aliased
  to `ecopulse/node_modules` via a `dep()` helper; manual vendor chunks
  (ethers, recharts, socket, leaflet).
- **`vercel.json`** — security headers (`X-Content-Type-Options`,
  `X-Frame-Options: DENY`, HSTS, Permissions-Policy) + strict **CSP** (scripts
  from self + Cloudflare Turnstile + Google reCAPTCHA + hCaptcha; `connect-src
  'self' https: wss:`) + SPA fallback rewrite.
- **Legacy scaffold** (`ecopulse/src/components/WalletConnect.jsx`, etc.) is
  **not** wired into `App.jsx` — the real ones live in `frontend/`.

## 4.2 Utils (`frontend/utils/`)
- **`api.js` (529)** — **the central fetch client**.
  - `API_BASE` from `VITE_API_URL` (prod-required); `SOCKET_URL` from
    `VITE_SOCKET_URL`.
  - `ApiError(message, status, details, code)`.
  - `configureApiAuth(handlers)` (`:35`) — injection point for `SessionBridge`
    (no React dependency in api.js).
  - **CSRF**: `ensureCsrfToken` (`:57`) bootstraps via `GET /auth/captcha-config`
    with `credentials:'include'`; `X-CSRF-Token` attached only to non-safe
    methods.
  - **`fetchApi(path, options)` (`:88`)** — the core. `execute(isRetry)` (`:105`):
    AbortController timeout (20s); on fetch throw → `REQUEST_TIMEOUT`/
    `NETWORK_ERROR`; **transparent 401 refresh** (`:146–159`): on 401 with code
    `TOKEN_EXPIRED|TOKEN_INVALID|NO_TOKEN` → `authHandlers.refreshSession()` →
    re-execute once (fresh httpOnly cookie auto-sent) else `onSessionExpired`.
  - `attemptWithWarmUp` (`:179`) — cold-start retry (safe methods or
    `retryOnColdStart`).
  - API namespaces: `authApi`, `walletApi`, `healthApi`, `analyticsApi`,
    `carbonApi`, `marketplaceApi`, `settlementsApi`, `tradesApi`, `nodesApi`,
    `readingsApi`, `forecastApi`, `anomalyApi`, `pricingApi`, `autoTradingApi`,
    `notificationApi`, `assistantApi`, `adminApi` (full admin surface).
- **`socketClient.js` (27)** — Socket.io options (websocket-first, polling
  fallback, `withCredentials:true`, reconnection 20 attempts). `configureSocketAuth`
  is a **no-op** — socket auth is cookie-based (server reads the httpOnly cookie
  in the handshake).
- **`blockchain.js` (504)** — the on-chain client. `getProvider` →
  `BrowserProvider(window.ethereum)`. `ensureCorrectNetwork` (switch/add chain).
  ABIs for CC/Trading/Escrow/Bridge. `executeSignedTx` (`:339`) wrapper.
  Reads (`getCarbonCreditBalance`, `getEscrow`, `fetchAllListings`) + writes
  (`listEnergy`, `purchaseEnergy`, `createEscrow`, `releaseEscrow`,
  `transferCarbonCredits`, `retireCredits`, `initiateBridgeLock`,
  `approveTokensIfNeeded` allowance-aware). Event subscriptions.
- **`walletLink.js` (38)** + **`walletStorage.js` (46)** — EIP-712 signing
  (`signTypedData` verbatim — server re-derives) + sessionStorage session (4h TTL).
- **`validation.js` (91)** — `validateWalletAddress` (regex + ethers EIP-55
  checksum), `isAddressChecksumAmbiguous` (address-poisoning warning).
- **`permissions.js` (64)** — client-side RBAC mirror (UI-gating only; server
  is the real authority).
- **`captcha.js` (101)** — multi-provider CAPTCHA (turnstile/hcaptcha/recaptcha v3).
- **`safeRedirect.js` (17)** — blocks open redirects.
- **`dashboardRealtime.js` (68)** — pure reducers for the live feed.
- **`transactionUtils.js` (147)** — trade shaping/filtering.
- **`clientLogger.js` (46)** — centralized client error reporting.
- **`adminFormat.jsx` / `adminNav.jsx`** — admin display helpers + nav config.

## 4.3 Contexts (`frontend/context/`)
- **`AuthContext.jsx` (242)** — **cookie-based auth** (no bearer in memory).
  `refreshSession` (`:21`) POSTs `/auth/refresh` with `credentials:'include'`;
  single-flight via `refreshPromiseRef`. `fetchCurrentUser` retries once on
  `TOKEN_EXPIRED`. `login`/`register`/`logout`/`updateProfile`/`updatePassword`.
- **`SocketContext.jsx` (180)** — **split contexts** (API + status) to minimize
  re-renders. One socket, created once. Reconnect fan-out only after first
  connect. Hooks: `useSocketApi`, `useSocketStatus`, `useSocketReconnect`,
  `useSocketEvent` (ref-held handler).
- **`WalletContext.jsx` (392)** — MetaMask state machine (account, chainId,
  balance, status). Polls for `window.ethereum` every 2s (late injection).
  Silent reconnect via `eth_accounts`; explicit `eth_requestAccounts` when
  needed. Subscribes to CC transfers to refresh balance.
- **`ToastContext.jsx` (106)** — lightweight toasts (last 5, auto-dismiss).
- **`SessionBridge.jsx` (26)** — renders nothing; calls `configureApiAuth` once
  (glue between cookie-auth AuthContext + the fetch client's refresh logic).

## 4.4 Hooks (`frontend/hooks/`)
- **`useDashboardRealtime.js` (56)** — batches `newReading` (80ms) + handles
  `analyticsUpdate` (realtime patch vs full replace).
- **`useAssistantChat.js` (151)** — assistant message state + sessionId;
  maps 429→rate-limit, 503→unavailable.
- **`useNodeForecast.js` (205)** — per-node + bulk forecasts; stale-response
  guard via monotonic `reqIdRef`; falls back to `useDummy` when model
  unavailable.
- **`useSettlementStatus.js` (149)** — verifies → polls with exponential
  backoff (paused when hidden); **socket fast-path** on
  `settlementVerified`/`settlementMismatch` (strict txHash match).
- **`useVisibilityPolling.js` (48)** — interval that stops when tab hidden.
- **`settlementSocket.js` (103)** — pure validators (unit-tested, no React/api
  imports) — the audited security boundary ("never trust the wire").

## 4.5 Components (`frontend/components/`)
- **`AppLayout.jsx` / `Sidebar.jsx`** — user shell; sidebar filters nav by
  permission/role (UI gating only).
- **`WalletConnect.jsx` (frontend, 123)** / **`BlockchainStatus.jsx` (106)** —
  wallet card + chain status.
- **`ProtectedRoute.jsx` / `GuestRoute.jsx`** — route guards.
- **`EmailVerificationBanner.jsx`** — resend-verification with countdown.
- **`AppErrorBoundary.jsx`** — class error boundary + client logging.
- **`assistant/AssistantChat.jsx` (178)** — floating chat widget.
- **`admin/AdminLayout.jsx` + `AdminSidebar.jsx`** — admin shell.
- **`settlement/SettlementStatusTimeline.jsx`** — settlement UI.
- **`settings/WalletLinkCard.jsx` (229)** — "sign to link" wallet binding;
  unlink requires password re-auth.
- **`trading/LiveTradeTicker.jsx` (143)** — anonymized live ticker (all values
  text-rendered → no XSS).
- **`trading/EnergyFlowSankey.jsx` (331)** — dependency-free SVG Sankey.

## 4.6 Pages (`frontend/pages/`)
- **`Login.jsx` (113)** / **`Register.jsx` (267)** / **`VerifyEmail.jsx` (83)** —
  auth flows (CAPTCHA, requiresLogin routing).
- **`Dashboard.jsx` (173)** — summary + nodes + forecast in parallel; realtime
  merge; reconnect re-sync.
- **`Trading.jsx` (1071)** — marketplace hub: listings (API → wallet-RPC
  fallback), order book depth, history, forecast suggestion, socket events,
  wallet guards, chain actions (list/purchase/escrow/cancel), rating,
  `LiveTradeTicker`, `SettlementStatusTimeline`.
- **`AutoTrading.jsx` (384)** — EIP-712 signed-intent auto-listing (identical
  encoding to backend; BigInts; micro-CC scale; 24h expiry; notify-only).
- **`Forecasts.jsx` (447)** — aggregate/single/compare-all; multi-horizon;
  `useDummy` fallback on `MODEL_UNAVAILABLE`.
- **`Credits.jsx` (344)** / **`CarbonWallet.jsx` (350)** / **`CarbonTransactions.jsx` (819)** —
  carbon metrics, balance + pending settlements, transfers + retirements
  (address-poisoning confirm modal).
- **`Settings.jsx` (374)** — profile (name only; wallet edited elsewhere),
  preferences, password, **anomaly feed** (`anomalyApi.list`).
- **`pages/admin/*`** — AdminHome, Users (admin grant/confirm dialog), Nodes
  (cascade delete), Trades, ReportJobs (retry failed email), SyncStatus,
  Health (unified probes), Ingestion (mode + backfill tool), Simulator
  (config/failure modes/diurnal preview), AuditLogs (placeholder). All gate
  mutations with `canMutate(currentUser)`.

## 4.7 Constants
- **`frontend/constants/socketEvents.js` (18)** — frontend mirror of
  `backend/socket/events.js` (must stay in sync).

---

# 5. Smart Contracts Recap

6 contracts (`contracts/`), Solidity `^0.8.28`, OpenZeppelin 5.x, deployed via
`ignition/modules/EnergySystem.js`:

1. **CarbonCredit** — capped ERC-20 `CC`. `MINTER_ROLE`/`DEFAULT_ADMIN_ROLE`.
   Mint (cap + per-tx limit), burn/retire (→ `RetirementRegistry`), bridge
   `MINTER_ROLE` grant.
2. **EnergyTrading** — P2P order book. List (never/expiring `[1m,90d]`), full +
   partial purchase, self-cleaning expiry, `Pausable`.
3. **EnergyEscrow** — conditional settlement. `Funded → Delivered → Released`
   (+ Disputed/Refunded). Timeout refund. Trusted `executeResolution` callback.
4. **DisputeResolution** — `ARBITER_ROLE` rules (Release/Refund/Split).
5. **RetirementRegistry** — on-chain retirement ledger + `ATTESTER_ROLE`
   provenance.
6. **CarbonCreditBridge** — lock/mint cross-chain. `RELAYER_ROLE`, one-time
   nonces, per-tx + daily caps, CEI + ReentrancyGuard.

All carry `AUDIT REQUIRED (C8)` notices; `AUDIT_STATUS = "UNAUDITED"`;
`AUDIT_MANIFEST.json` gates mainnet; `hardhat.config.js` blocks mainnet without
`MAINNET_AUDIT_ACK=confirmed`.

---

# 6. End-to-End Execution Walkthroughs

## 6.1 Telemetry ingestion (the data foundation)
```
Device → MQTT ecopulse/nodes/<nodeId>/telemetry
   (mqttIngestionService: TLS-only, 4KB cap, TTL device cache, ACL verify)
   OR device → POST /api/v1/telemetry (deviceAuth: bcrypt + lockout + anti-enumeration)
   OR publicGridPoller → adapter.fetchLatest → safeFetch (SSRF guard)
   OR embedded simulator (simulatorManager) / socket simulateReading (admin-only)
       ↓
   processDeviceTelemetry (ingestion/telemetryService)
       → validateEnvelope (clock-skew, capacity) → device→node binding check
       → dedup (Redis SET NX 86400) → readingService.ingestReading({source})
       → dual-write: EnergyReading (+ timeseriesWriter) → socket NEW_READING + ANALYTICS_UPDATE
       → (anomaly scoring via AI service → AnomalyEvent)
```

## 6.2 Forecast request
```
Browser Forecasts.jsx
  → GET /api/v1/forecast (JWT + CSRF) → forecastController (ownership asserted)
  → POST ai_service /forecast/  (x-internal-api-key)
     → ForecastService._forecast_for_node
         model resolution (version/per-node/global)
         → utils/database.get_historical_data (Mongo, daily aggregation)
         → preprocessing.prepare_for_prediction (last 30 days, scaled)
         → predict_multi_horizon (LSTM, single pass) OR predict_future (recursive)
         → _format_predictions (conformal/per-step/heuristic bands)
     ◄── predictions + model_status + version + scope
  → Recharts renders gen/con curves
```

## 6.3 Marketplace purchase (instant path)
```
1. Seller → Trading.jsx → listEnergy → EnergyTrading.listEnergy() on-chain → EnergyListed
2. blockchainSyncService indexes (chunked, idempotent) → Trade doc + listingCache invalidation
   → socket ORDERBOOK_UPDATE
3. Buyer sees order book → purchaseEnergy (approve-then-buy) → EnergyPurchased → CC transferred
4. Sync → Trade doc (purchased) → socket TRADE_EXECUTED (ticker)
5. Settlement worker → verifyPurchase (receipt + confirmation depth + listing struct match)
   → reconciliation (meter telemetry vs on-chain) → lifecycle timeline
```

## 6.4 Escrow path + dispute
```
Buyer → createEscrow (locks CC) → confirmDelivery (seller) → release (buyer)
   OR openDispute (within window) → DisputeResolution.openDispute
   OR claimTimeoutRefund (auto-refund)
Admin arbiter → DisputeResolution.resolve(outcome) → EnergyEscrow.executeResolution
   → backend mirror + disputeService audit + socket (wallet rooms only)
```

## 6.5 Assistant chat
```
AssistantChat → POST /api/v1/assistant/chat
  → assistantController.postAssistantChat
      → intentClassifier.classifyIntent
      → retrievalService.retrieveForIntent (ownership re-checked, 8KB cap)
      → genaiClient.fetchDocChunks (TopK=2)
      → genaiClient.postChat → genai-service /assistant/chat
          → build_assistant_chat_prompt (fenced, anti-injection)
          → LlmService.complete (Gemini) OR fallback_templates
          → sanitize (strip tags/script) → demo/live disclaimer
      ◄── { reply, disclaimer }
  → fire-and-forget session snapshot (metadata only)
```

## 6.6 Auto-trading (notify-only v1)
```
User → AutoTrading.jsx: enablePolicy (signs EIP-712 intent verbatim)
  → listingIntentService.createVerifiedIntent (verify signer, stale-nonce check)
autoListingMatcher worker (15 min) → autoTradingService.evaluateAll
  → kill switch (env + AutoTradingConfig.paused, fail-closed)
  → per-policy: surplus recommendation + intent bounds + quota (Redis)
  → handleMatch → notificationService.send (persist + socket + optional email)
  (server NEVER holds private keys; user confirms listEnergy in MetaMask)
```

## 6.7 Wallet linking (Module 8.4)
```
WalletLinkCard → walletApi.getChallenge(account) → walletLink.issueChallenge
  (rejects already-linked wallets; stores nonce + expiry on user doc)
→ signWalletLink(typedData) (signTypedData verbatim)
→ walletApi.link({wallet, signature}) → walletLink.linkWallet
  (rebuilds typed-data from SERVER-STORED challenge; atomic claim via nonce filter;
   race-safe; bumps nothing)
Unlink requires password re-auth (stolen-token defense).
```

---

*This walkthrough mirrors the repository as committed. For the authoritative
behavior of any function, follow the `file:line` references. The codebase is
defensive-by-design (anti-enumeration, IDOR guards, SSRF protection, NoSQL-
injection blocking, fail-closed feature flags, audit logging) and the smart
contracts are **unaudited** — treat all on-chain paths as not-yet-production-ready.*

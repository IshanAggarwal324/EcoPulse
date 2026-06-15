# EcoPulse Security

Security controls and operational guidance for the EcoPulse monorepo.

## Low-severity findings (L1–L15) — status

| ID | Finding | Mitigation |
|----|---------|------------|
| L1 | Dev scripts (`testBlockchain`, `promote-admin`) | Moved under `backend/scripts/`; require `ALLOW_DEV_SCRIPTS=true` and block in production |
| L2 | Hardhat boilerplate | Removed `Lock.sol` sample; `artifacts/`, `cache/`, `test/` excluded via `.gitignore` / `.dockerignore` |
| L3 | Logger logs full URLs | `backend/middleware/logger.js` redacts sensitive query parameters |
| L4 | No email verification enforcement | Email verification flow + `requireEmailVerified` middleware (production default). MFA/TOTP not yet implemented — recommended for a future release |
| L5 | `AppErrorBoundary` info leak | Generic message in production; details only in dev console |
| L6 | Wallet `sessionStorage` | 4-hour TTL + shared-device warnings in UI |
| L7 | `GuestRoute` open redirect | `getSafeRedirectPath()` allows same-origin relative paths only |
| L8 | Contract pause / mint cap | `CarbonCredit` has supply cap; `EnergyTrading` has `Pausable` + `onlyOwner` pause |
| L9 | Docs aid reconnaissance | `docs/README.md` marks internal docs; sensitive deployment notes redacted |
| L10 | Dependency CVEs not in CI | `.github/workflows/security.yml` runs `npm audit` / `pip-audit`; Dependabot enabled |
| L11 | Public Hardhat key fallback | Removed from runtime; production validation rejects known dev key via hash comparison |
| L12 | Bootstrap admin CLI | Requires `BOOTSTRAP_ADMIN_SECRET`; blocked in production |
| L13 | `CarbonCredit` `onlyOwner` mint | See [`contracts/SECURITY.md`](contracts/SECURITY.md) — secure owner key with hardware wallet / multisig |
| L14 | `EnergyTrading` `ReentrancyGuard` | Present on `purchaseEnergy` — no change required |
| L15 | Public health endpoint | Intentionally minimal at `/api/health` for load balancers |

## Route protection matrix (Section 7) — status

| Method | Route | Auth | Rate limit | Status |
|--------|-------|------|------------|--------|
| GET | `/` | None | No | OK — static API banner (low risk) |
| GET | `/api/health` | None | No | OK — minimal LB probe (see L15) |
| POST | `/auth/register`, `/login`, `/refresh` | None | Yes | Done — auth limiters + CAPTCHA on register |
| POST | `/auth/verify-email` | None | Yes | Done — 10 / 15 min |
| GET | `/auth/me` | User | No | OK — own profile only |
| PUT | `/auth/profile`, `/password` | User + verified | Yes | Done — 20 / 15 min |
| GET | `/nodes`, `/nodes/:id` | User + verified | No | Done — auth required; `userId` hidden from non-admins |
| POST/PUT/DELETE | `/nodes*` | Admin | No | Done — `authorize('admin')` on writes |
| GET | `/readings` | User + verified | No | Done — auth required; max 100 rows (500 for admin) |
| POST | `/readings` | Admin | No | Done |
| GET | `/forecast` | User + verified | Yes | Done — 30 / 15 min (configurable) |
| GET | `/analytics/*` | User + verified | No | Done — wallet scoped via `resolveWalletScope`; `/status` admin-only |
| GET/POST | `/trades/history/sync` | Admin | No | Done — `authorize('admin')` |
| GET | `/trades/history`, `/trades/tx/:hash` | User + verified | No | Done — wallet scoped; tx lookup filtered by wallet |
| GET | `/marketplace/orders*` | User + verified | No | Done — auth required (marketplace listings are non-sensitive) |
| POST | `/assistant/chat`, `/report` | User + verified | Yes | Done — chat/report limiters |
| GET | `/assistant/report/preview` | User + verified | Yes | Done — preview limiter + wallet IDOR fix |
| `/admin/*` | * | Admin/mod | Yes | Done — admin limiter + role checks |

All `/api/v1` feature routes (except `/auth`) require `protect` + `requireEmailVerified` at the router level in `routes/v1.js`.

## Environment variables (security-related)

```bash
# Dev scripts (never set in production)
ALLOW_DEV_SCRIPTS=true

# One-time admin bootstrap (min 16 chars)
BOOTSTRAP_ADMIN_SECRET=long-random-secret
BOOTSTRAP_ADMIN_EMAIL=admin@example.com

# Email verification (default: required in production)
REQUIRE_EMAIL_VERIFICATION=true

# Never use the Hardhat default private key in production
PRIVATE_KEY=your-server-wallet-key
```

## Running dev-only scripts

```bash
# backend/.env
ALLOW_DEV_SCRIPTS=true

node backend/scripts/testBlockchain.js
node backend/scripts/promote-admin.js admin@example.com --secret=your-bootstrap-secret
```

## Dependency audits

CI runs on push/PR and weekly. Locally:

```bash
npm audit --audit-level=moderate --prefix backend
npm audit --audit-level=moderate --prefix ecopulse
npm audit --audit-level=moderate --prefix genai-service
python -m pip_audit -r ai_service/requirements.txt
python -m pip_audit -r genai-service/requirements.txt
```

Production dependency policies:

- **Node:** `ws@8.21.0` forced via npm `overrides` (ethers nested dependency); `nodemailer@9.x` for SMTP injection fixes; `esbuild@0.28.1` override in frontend for Vite dev/build tooling.
- **Python:** `ai_service` requirements contain only forecast/ML deps; Gemini SDK lives in `genai-service/requirements.txt` only.

## If a private key was ever committed (historical leak)

Even after removing keys from the current tree, **git history may still contain them**. Treat any key that was ever in the repo as **compromised**.

1. **Rotate immediately** (production / testnet / any wallet that used the leaked key):
   - Generate a new wallet; update `PRIVATE_KEY` in deployment secrets (Render, Vercel env, etc.).
   - If the Hardhat default key was used on a testnet, assume that account is public — do not hold funds on it.
   - Rotate `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `BOOTSTRAP_ADMIN_SECRET` if they were ever committed.

2. **Current repo protections:**
   - CI blocks `PRIVATE_KEY=0x<64-hex>` and the known Hardhat dev key in source (excluding `.example`, `docs/`, `.github/`).
   - `backend/config/env.js` compares keys via SHA-256 only — the raw Hardhat key is not stored in code.
   - gitleaks runs on every push/PR.

3. **Optional — purge from git history** (only if you must remove secrets from old commits; coordinate with all collaborators):
   ```bash
   # Example using git-filter-repo (install separately)
   git filter-repo --invert-paths --path-glob '*.env' --force
   # Or use BFG Repo-Cleaner / GitHub secret scanning remediation docs
   ```
   After rewriting history: force-push requires team agreement; everyone must re-clone.

4. **Verify locally** (both should return no matches in tracked source):
   ```bash
   git grep -nE 'PRIVATE_KEY=0x[0-9a-fA-F]{64}' -- ':!*.example' ':!docs/*' ':!.github/*'
   ```

## Reporting vulnerabilities

Please report security issues privately to the repository maintainers rather than opening public issues.

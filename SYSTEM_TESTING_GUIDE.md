# EcoPulse System Testing Guide

This guide explains how to run end-to-end system testing for the EcoPulse stack (backend + frontend integration), reproduce common failures, and verify expected behavior.

## Prerequisites

- Node.js installed (recommended: active LTS)
- npm installed
- Backend dependencies installed in `backend`
- Frontend dependencies installed in `ecopulse`
- Backend `.env` configured in `backend/.env`

Recommended local defaults:

- `PORT=5001`
- `FRONTEND_URL=http://localhost:5173`
- `SOCKET_CORS_ORIGIN=http://localhost:5173`

For the frontend (`ecopulse/.env`):

- `VITE_API_URL=http://localhost:5001/api/v1`
- `VITE_SOCKET_URL=http://localhost:5001`

## 1) Start Backend

Open a terminal:

```bash
cd backend
npm run dev
```

Expected output includes:

- `Server is running on port 5001`
- MongoDB connected log

Notes:

- If blockchain RPC is not running, you may see `ECONNREFUSED 127.0.0.1:8545`. This is acceptable for non-blockchain system tests.

## 2) Run Backend MVP End-to-End Test

In a second terminal:

```bash
cd backend
npm test
```

Expected pass output includes:

- `EcoPulse MVP E2E Test`
- `✓ Health check`
- `✓ Analytics summary & sub-endpoints`
- `✓ Reading creation updates aggregates`
- `✓ Blockchain sync endpoint`
- `All MVP workflow checks passed.`

Possible warnings that are acceptable:

- `Blockchain sync skipped (chain offline or unconfigured)`
- `AI forecast unavailable (service may be offline)`

## 3) API Smoke Test (Manual)

Run:

```bash
cd backend
node -e "Promise.all([fetch('http://localhost:5001/api/health').then(r=>r.json()),fetch('http://localhost:5001/api/v1/analytics/summary').then(r=>r.json())]).then(([h,s])=>{console.log('health',h.status);console.log('summary ok',!!s.success,'readings',s?.data?.energy?.readingCount);}).catch(e=>{console.error(e.message);process.exit(1);});"
```

Expected:

- `health OK`
- `summary ok true readings <number>`

## 4) Build Frontend (Integration Validation)

Open another terminal:

```bash
cd ecopulse
npm run build
```

Expected:

- Build completes successfully
- Output assets are generated in `ecopulse/dist`

## 5) Optional Runtime UI Check

To run the frontend app locally:

```bash
cd ecopulse
npm run dev
```

Then open the local Vite URL (usually `http://localhost:5173`) and verify:

- Login/register calls succeed
- Dashboard loads summary cards and node panel
- Trading page loads order book and transaction history
- Refresh actions do not produce API/CORS failures

## Common Failure Patterns and Fixes

1. Port mismatch (5000 vs 5001)

- Symptom: fetch failures in tests/UI
- Fix: align backend `PORT`, frontend `VITE_API_URL`/`VITE_SOCKET_URL`, and E2E test base URL

2. CORS origin typo/mismatch

- Symptom: requests blocked in browser
- Fix: ensure `FRONTEND_URL` and `SOCKET_CORS_ORIGIN` match the frontend dev origin

3. Blockchain node unavailable

- Symptom: `ECONNREFUSED` to `127.0.0.1:8545`
- Fix: start Hardhat node if blockchain flows are needed, otherwise proceed with API-level checks

## Regression Checklist

Run this checklist before merging integration changes:

- [ ] `backend` starts with no fatal errors
- [ ] `backend npm test` passes
- [ ] `/api/health` and `/api/v1/analytics/summary` are reachable
- [ ] `ecopulse npm run build` passes
- [ ] Frontend env points to backend port correctly
- [ ] No CORS errors in browser console during key flows


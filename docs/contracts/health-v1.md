# EcoPulse Health Contract — v1.0

Canonical machine schema: [`shared/healthContract.json`](../../shared/healthContract.json)
(JSON Schema draft-07). This document is the human-readable spec + security
rules. When the two disagree, the JSON Schema wins for validation.

## Why

Before this contract each service returned an ad-hoc shape (`OK` vs `ok` vs
`degraded`, `gemini_status` vs `available`, etc.). Probes, the status
aggregator, and the admin UI all had to special-case every service. v1 gives
every tier one shape so anything that reads health can be generic.

## Shape

```json
{
  "schemaVersion": "1.0",
  "service": "ecopulse-backend",
  "status": "healthy | degraded | unhealthy",
  "checkedAt": "2026-07-02T12:00:00.000Z",
  "uptimeSeconds": 3600,
  "checks": [
    {
      "id": "mongodb",
      "status": "healthy",
      "latencyMs": 12,
      "details": { "readyState": 1 }
    }
  ]
}
```

### Status enum

| Value       | Meaning                                                         |
|-------------|----------------------------------------------------------------|
| `healthy`   | Fully serving traffic.                                          |
| `degraded`  | Serving, but a dependency is impaired (fallback / partial).    |
| `unhealthy` | Cannot serve correctly. Readiness probes should return 503.    |

`status` is always the **worst** of the service's own state and every entry in
`checks[]`. A failing dependency therefore can never read as `healthy`.

### Endpoint split (Kubernetes/readiness convention)

| Endpoint        | Purpose                          | When 503?                  | Notes                                   |
|-----------------|----------------------------------|----------------------------|-----------------------------------------|
| `/health/live`  | Liveness — process is alive      | Never (always 200)         | Zero I/O, safe for high-frequency probes |
| `/health/ready` | Readiness — ready to serve       | When `status !== healthy`  | Returns the full contract body on 503   |
| `/health`       | Full check (default probe target)| Never                      | Legacy keys kept for backward compat    |

`/health/live` MUST do no I/O and depend on no dependency, so a slow/down
dependency can never make the orchestrator kill and restart a healthy process.

## Per-service implementation

| Service        | Files                                              | Checks emitted                                  |
|----------------|----------------------------------------------------|-------------------------------------------------|
| backend        | `backend/services/healthService.js`                | `mongodb`, `ai_service`, `genai_service`, `blockchain`, `backend`, `simulator` |
| ai_service     | `ai_service/app/routers/health.py` + `app/health_contract.py` | `model` (`model_loaded`)                |
| genai-service  | `genai-service/app/routers/health.py` + `app/health_contract.py` | `gemini` (from `genai_available`)        |

The backend exposes the contract via the existing `getHealth()` output
(additive: `schemaVersion`, `service`, `status`, `uptimeSeconds`, `checks[]`
alongside the legacy `overall`/`components` fields) and via
`healthService.toHealthContract()`.

## SECURITY RULES (production)

`/health*` routes are **exempt from internal API-key auth** so orchestrators
(Docker `HEALTHCHECK`, Kubernetes probes, load balancers) can reach them
without credentials. That exemption is only safe because of these rules:

1. **No secrets in health responses — ever.** `details` may only contain
   booleans, counts, and public identifiers. Never API keys, passwords,
   connection strings, JWTs, or full RPC URLs. The backend scrubs embedded URLs
   and masks RPC hosts to their hostname (`scrubMessage` / `maskUrlHost`).
2. **Liveness is free.** `/health/live` performs no I/O and touches no
   dependency, so it cannot be used to amplify load against downstream systems.
3. **Readiness reflects real readiness.** `/health/ready` returns 503 when the
   service cannot serve; orchestrators route traffic away accordingly.
4. **Aggregate/detail endpoints stay gated.** Full component detail
   (`/admin/health`, future `/api/health/status`) is admin-protected and/or
   rate-limited; only the minimal `/health/live` is open.

## Validation

Tests validate each service's health output against
`shared/healthContract.json`:

- Backend: `backend/tests/healthContract.test.js`
- ai_service / genai-service: `tests/test_health_contract.py`

## Changelog

- **1.0** — Initial shared contract (Module 7.1). Normalizes status enum to
  `healthy | degraded | unhealthy`; introduces `/health/live` + `/health/ready`.

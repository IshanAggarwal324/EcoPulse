"""EcoPulse health contract v1.0 builder.

The single source of truth is ``shared/healthContract.json`` (JSON Schema
draft-07). Every service returns this shape from its health endpoints so
probes, the ``/api/health/status`` aggregator, and the admin UI render
consistently. See ``docs/contracts/health-v1.md``.

SECURITY: ``/health*`` routes are exempt from the internal API-key gate so
orchestrators (Docker HEALTHCHECK, Kubernetes, load balancers) can probe them
without credentials. Because of that exemption only NON-SENSITIVE fields may
ever appear here — never API keys, passwords, connection strings, JWTs, or
full URLs. Build ``details`` explicitly from safe primitives.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = "1.0"

HEALTHY = "healthy"
DEGRADED = "degraded"
UNHEALTHY = "unhealthy"

_RANK = {HEALTHY: 0, DEGRADED: 1, UNHEALTHY: 2}

# Captured at import time so uptime is monotonic and cheap to read.
_START_TIME = time.time()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def uptime_seconds() -> int:
    return max(0, int(time.time() - _START_TIME))


def normalize_status(status: Any) -> str:
    """Map ad-hoc status values (ok/up/available/down/...) to the contract enum.

    Unknown / empty values fail closed to ``unhealthy``.
    """
    value = str(status or "").strip().lower()
    if value in (HEALTHY, "ok", "up", "ready", "available", "true"):
        return HEALTHY
    if value in (DEGRADED, "partial", "fallback"):
        return DEGRADED
    return UNHEALTHY


def build_contract(
    service: str,
    status: Any,
    checks: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Assemble a v1 health-contract payload.

    ``status`` and every check status are normalized to the contract enum, and
    the overall ``status`` is derived as the WORST of the service status and
    every check — so a failing dependency can never read as ``healthy``.
    """
    normalized_checks: list[dict[str, Any]] = []
    statuses: list[str] = [normalize_status(status)]

    for check in checks or []:
        entry = dict(check)
        entry["status"] = normalize_status(entry.get("status"))
        entry.setdefault("id", "unknown")
        normalized_checks.append(entry)
        statuses.append(entry["status"])

    worst = max(statuses, key=lambda s: _RANK.get(s, _RANK[UNHEALTHY]))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "service": service,
        "status": worst,
        "checkedAt": _now_iso(),
        "uptimeSeconds": uptime_seconds(),
        "checks": normalized_checks,
    }

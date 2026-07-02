"""Internal service API-key gate (Sub-module security C7).

``/health*`` and ``/metrics`` are exempt from the internal API-key gate:
health probes run from orchestrators without credentials, and ``/metrics`` is
protected by its own METRICS_TOKEN (Module 7.5) so a Prometheus scraper can
reach it. Every other path still requires the shared internal API key.
"""
from fastapi.responses import JSONResponse


def internal_auth_response(path: str, configured_key: str, provided_key: str | None):
    if path.startswith("/health") or path == "/metrics":
        return None
    if not configured_key:
        return JSONResponse(
            status_code=503,
            content={"detail": "Internal service authentication is not configured"},
        )
    if provided_key != configured_key:
        return JSONResponse(status_code=401, content={"detail": "Unauthorized internal request"})
    return None

"""Internal service API-key gate (Sub-module security C7)."""
from fastapi.responses import JSONResponse


def internal_auth_response(path: str, configured_key: str, provided_key: str | None):
    if path.startswith("/health"):
        return None
    if not configured_key:
        return JSONResponse(
            status_code=503,
            content={"detail": "Internal service authentication is not configured"},
        )
    if provided_key != configured_key:
        return JSONResponse(status_code=401, content={"detail": "Unauthorized internal request"})
    return None

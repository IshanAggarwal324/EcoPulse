import logging

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.health_contract import DEGRADED, HEALTHY, build_contract
from app.services.llm_service import REASON_NOT_CONFIGURED, REASON_OK

router = APIRouter(tags=["Health"])
logger = logging.getLogger(__name__)

SERVICE_NAME = "ecopulse-genai-service"


def _gemini_check(
    available: bool,
    model: str,
    reason: str | None = None,
    latency_ms: int = 0,
) -> dict:
    details = {
        "provider": "gemini",
        "model": model,
        "fallbackMode": not available,
    }
    if reason is not None:
        # Coarse enum only (ok | not_configured | model_not_found | auth_failed
        # | rate_limited | timeout | upstream_unavailable | error). Never a raw
        # SDK message: this route is reachable without credentials.
        details["reason"] = reason
    return {
        "id": "gemini",
        "status": HEALTHY if available else DEGRADED,
        "latencyMs": latency_ms,
        "details": details,
    }


def _build_contract(
    available: bool,
    model: str,
    reason: str | None = None,
    latency_ms: int = 0,
) -> dict:
    return build_contract(
        SERVICE_NAME,
        HEALTHY if available else DEGRADED,
        [_gemini_check(available, model, reason, latency_ms)],
    )


@router.get("/")
async def root():
    return {"status": "ok", "message": "EcoPulse GenAI Service is running."}


@router.get("/health/live")
async def health_live():
    """Liveness probe — the process is alive and serving.

    Zero I/O and no dependency checks, so a slow/down Gemini API can never
    cause the orchestrator to restart a healthy process. Always 200.
    """
    return build_contract(SERVICE_NAME, HEALTHY, [])


@router.get("/health/ready")
async def health_ready():
    """Readiness probe — Gemini is configured and the service can serve.

    Configuration-only (no Gemini call): a transient Gemini outage must not
    pull the whole service out of rotation, because the service keeps serving
    template fallbacks. Use ``/health`` for the live Gemini check.

    Returns 503 (with the full contract body) when Gemini is unavailable so
    orchestrators route traffic away until ready.
    """
    settings = get_settings()
    available = bool(settings.genai_available)
    contract = _build_contract(available, settings.genai_model)
    if not available:
        return JSONResponse(status_code=503, content=contract)
    return contract


@router.get("/health")
async def health(request: Request):
    """Full health check (contract v1) with a live, cached Gemini probe.

    ``available`` is true only when Gemini is configured AND a real call to the
    configured model succeeded recently. A shut-down model, revoked key or
    unreachable API therefore reads ``degraded`` (the service still answers
    with template fallbacks) instead of falsely reporting healthy. The probe
    result is cached (``GENAI_HEALTH_PROBE_TTL_SECONDS``), so this route costs
    at most one tiny Gemini call per TTL window.

    Legacy keys (``available``, ``provider``, ``model``, ``fallbackMode``,
    ``docs_loaded_count``) are preserved for backward compatibility with the
    backend's probe parser; ``status`` is normalized to the contract enum.
    """
    settings = get_settings()
    configured = bool(settings.genai_available)
    rag = getattr(request.app.state, "doc_rag_service", None)
    docs_loaded_count = rag.docs_loaded_count if rag is not None else 0

    probe = getattr(request.app.state, "gemini_probe", None)
    latency_ms = 0
    if not configured:
        available, reason = False, REASON_NOT_CONFIGURED
    elif probe is None:
        # Probe disabled/unavailable: fall back to the configuration check.
        available, reason = True, None
    else:
        # check() blocks on a network call, so keep it off the event loop.
        result = await run_in_threadpool(probe.check)
        available = result.ok
        reason = result.reason if not result.ok else REASON_OK
        latency_ms = result.latency_ms

    contract = _build_contract(available, settings.genai_model, reason, latency_ms)
    return {
        **contract,
        "provider": "gemini",
        "available": available,
        "model": settings.genai_model,
        "fallbackMode": not available,
        "docs_loaded_count": docs_loaded_count,
    }


@router.get("/health/genai")
async def genai_health():
    settings = get_settings()
    return {
        "available": settings.genai_available,
        "model": settings.genai_model,
        "fallbackMode": not settings.genai_available,
        "provider": "gemini",
    }

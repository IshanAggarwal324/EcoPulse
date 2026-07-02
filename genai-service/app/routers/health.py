import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.health_contract import DEGRADED, HEALTHY, build_contract

router = APIRouter(tags=["Health"])
logger = logging.getLogger(__name__)

SERVICE_NAME = "ecopulse-genai-service"


def _gemini_check(available: bool, model: str) -> dict:
    return {
        "id": "gemini",
        "status": HEALTHY if available else DEGRADED,
        "latencyMs": 0,
        "details": {
            "provider": "gemini",
            "model": model,
            "fallbackMode": not available,
        },
    }


def _build_contract(available: bool, model: str) -> dict:
    return build_contract(
        SERVICE_NAME,
        HEALTHY if available else DEGRADED,
        [_gemini_check(available, model)],
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
    """Readiness probe — Gemini is available and the service can serve.

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
    """Full health check (contract v1).

    Legacy keys (``available``, ``provider``, ``model``, ``fallbackMode``,
    ``docs_loaded_count``) are preserved for backward compatibility with the
    backend's probe parser; ``status`` is normalized to the contract enum.
    """
    settings = get_settings()
    available = bool(settings.genai_available)
    rag = getattr(request.app.state, "doc_rag_service", None)
    docs_loaded_count = rag.docs_loaded_count if rag is not None else 0
    contract = _build_contract(available, settings.genai_model)
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

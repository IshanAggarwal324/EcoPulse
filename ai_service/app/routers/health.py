import logging

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.dependencies import get_model_store
from app.health_contract import DEGRADED, HEALTHY, UNHEALTHY, build_contract
from app.services.model_store import ModelStore

router = APIRouter(tags=["Health"])
logger = logging.getLogger(__name__)

SERVICE_NAME = "ecopulse-ai-service"


def _model_check(
    model_loaded: bool,
    fallback_enabled: bool,
    retry_after_seconds: int,
) -> dict:
    return {
        "id": "model",
        "status": HEALTHY if model_loaded else DEGRADED,
        "latencyMs": 0,
        "details": {
            "model_loaded": model_loaded,
            "fallback_enabled": fallback_enabled,
            "retry_after_seconds": retry_after_seconds,
        },
    }


@router.get("/")
async def root():
    return {"status": "ok", "message": "EcoPulse AI Service is running."}


@router.get("/health/live")
async def health_live():
    """Liveness probe — the process is alive and serving.

    Zero I/O and no dependency checks, so a slow/down model or dependency can
    never cause the orchestrator to restart a healthy process. Always 200.
    """
    return build_contract(SERVICE_NAME, HEALTHY, [])


@router.get("/health/ready")
async def health_ready(model_store: ModelStore = Depends(get_model_store)):
    """Readiness probe — service can accept forecast traffic.

    If model artifacts are missing but heuristic fallback mode is enabled
    (ALLOW_MODEL_FREE_DUMMY=true), the service remains routable and reports
    DEGRADED (HTTP 200) rather than hard unready.
    """
    model_loaded = bool(model_store.is_ready)
    fallback_enabled = bool(model_store.allow_model_free_dummy)
    retry_after_seconds = model_store.model_load_retry_after_seconds
    ready_for_traffic = model_loaded or fallback_enabled
    contract = build_contract(
        SERVICE_NAME,
        HEALTHY if model_loaded else DEGRADED,
        [_model_check(model_loaded, fallback_enabled, retry_after_seconds)],
    )
    if not ready_for_traffic:
        return JSONResponse(status_code=503, content=contract)
    return contract


@router.get("/health")
async def health(model_store: ModelStore = Depends(get_model_store)):
    """Full health check (contract v1).

    Legacy keys (``model_loaded``, ``status``) are preserved for backward
    compatibility with the backend's probe parser; ``status`` is normalized to
    the contract enum.
    """
    model_loaded = bool(model_store.is_ready)
    fallback_enabled = bool(model_store.allow_model_free_dummy)
    retry_after_seconds = model_store.model_load_retry_after_seconds
    contract = build_contract(
        SERVICE_NAME,
        HEALTHY if model_loaded else DEGRADED,
        [_model_check(model_loaded, fallback_enabled, retry_after_seconds)],
    )
    return {
        **contract,
        "model_loaded": model_loaded,
        "fallback_enabled": fallback_enabled,
        "ready_for_traffic": model_loaded or fallback_enabled,
    }

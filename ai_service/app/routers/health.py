import logging

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.dependencies import get_model_store
from app.health_contract import DEGRADED, HEALTHY, UNHEALTHY, build_contract
from app.services.model_store import ModelStore

router = APIRouter(tags=["Health"])
logger = logging.getLogger(__name__)

SERVICE_NAME = "ecopulse-ai-service"


def _model_check(model_loaded: bool) -> dict:
    return {
        "id": "model",
        "status": HEALTHY if model_loaded else DEGRADED,
        "latencyMs": 0,
        "details": {"model_loaded": model_loaded},
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
    """Readiness probe — model artifacts loaded and the service can infer.

    Returns 503 (with the full contract body) when the model is not yet loaded
    so orchestrators route traffic away until ready.
    """
    model_loaded = bool(model_store.is_ready)
    contract = build_contract(
        SERVICE_NAME,
        HEALTHY if model_loaded else DEGRADED,
        [_model_check(model_loaded)],
    )
    if not model_loaded:
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
    contract = build_contract(
        SERVICE_NAME,
        HEALTHY if model_loaded else DEGRADED,
        [_model_check(model_loaded)],
    )
    return {**contract, "model_loaded": model_loaded}

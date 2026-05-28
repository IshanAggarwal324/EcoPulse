import logging

from fastapi import APIRouter, Depends

from app.dependencies import get_model_store
from app.services.model_store import ModelStore

router = APIRouter(tags=["Health"])
logger = logging.getLogger(__name__)


@router.get("/")
async def root():
    return {"status": "ok", "message": "EcoPulse AI Service is running."}


@router.get("/health")
async def health(model_store: ModelStore = Depends(get_model_store)):
    return {
        "status": "ok" if model_store.is_ready else "degraded",
        "model_loaded": model_store.is_ready,
    }

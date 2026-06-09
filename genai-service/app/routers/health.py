import logging

from fastapi import APIRouter

from app.config import get_settings

router = APIRouter(tags=["Health"])
logger = logging.getLogger(__name__)


@router.get("/")
async def root():
    return {"status": "ok", "message": "EcoPulse GenAI Service is running."}


@router.get("/health")
async def health():
    settings = get_settings()
    return {
        "status": "ok" if settings.genai_available else "degraded",
        "provider": "gemini",
        "available": settings.genai_available,
        "model": settings.genai_model,
        "fallbackMode": not settings.genai_available,
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

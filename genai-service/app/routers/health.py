import logging

from fastapi import APIRouter, Request

from app.config import get_settings

router = APIRouter(tags=["Health"])
logger = logging.getLogger(__name__)


@router.get("/")
async def root():
    return {"status": "ok", "message": "EcoPulse GenAI Service is running."}


@router.get("/health")
async def health(request: Request):
    settings = get_settings()
    rag = getattr(request.app.state, "doc_rag_service", None)
    docs_loaded_count = rag.docs_loaded_count if rag is not None else 0
    return {
        "status": "ok" if settings.genai_available else "degraded",
        "provider": "gemini",
        "available": settings.genai_available,
        "model": settings.genai_model,
        "fallbackMode": not settings.genai_available,
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

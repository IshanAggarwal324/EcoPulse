import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routers import assistant, health, reports
from app.services.doc_rag_service import DocRagService
from app.services.llm_service import LlmService

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    settings = get_settings()
    is_production = os.getenv("NODE_ENV") == "production"
    if os.getenv("NODE_ENV") == "production" and not settings.internal_api_key:
        raise RuntimeError("INTERNAL_SERVICE_API_KEY must be configured in production")
    if is_production and not settings.cors_origins:
        raise RuntimeError("GENAI_CORS_ORIGINS must be configured in production")
    if is_production and any(origin == "*" for origin in settings.cors_origins):
        raise RuntimeError("GENAI_CORS_ORIGINS cannot contain '*' in production")

    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )

    app = FastAPI(
        title=settings.app_name,
        description="GenAI service for EcoPulse — chat assistant and report narration via Gemini",
        version=settings.app_version,
        docs_url=None if is_production else "/docs",
        redoc_url=None if is_production else "/redoc",
        openapi_url=None if is_production else "/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def internal_auth_middleware(request: Request, call_next):
        if request.url.path.startswith("/health"):
            return await call_next(request)
        if settings.internal_api_key:
            provided = request.headers.get("x-internal-api-key")
            if provided != settings.internal_api_key:
                return JSONResponse(status_code=401, content={"detail": "Unauthorized internal request"})
        return await call_next(request)

    @app.exception_handler(RuntimeError)
    async def _gemini_error_handler(request: Request, exc: RuntimeError):
        msg = str(exc)
        if "Gemini" in msg or "not available" in msg:
            logger.warning("Gemini error on %s: %s", request.url.path, msg)
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "Gemini service is temporarily unavailable.",
                    "fallback_available": True,
                },
            )
        raise exc

    @app.on_event("startup")
    def _init_services():
        app.state.llm_service = LlmService(settings)

        rag = DocRagService(settings)
        rag.initialize()
        app.state.doc_rag_service = rag

    app.include_router(health.router)
    app.include_router(reports.router)
    app.include_router(assistant.router)

    return app

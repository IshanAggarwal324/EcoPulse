from contextlib import asynccontextmanager
import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.dependencies import get_anomaly_store, get_model_store
from app.handlers.exceptions import register_exception_handlers
from app.internal_auth import internal_auth_response
from app.logging_config import setup_logging
from app.middleware import request_logging_middleware
from app.routers import anomaly, forecast, health, models

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    setup_logging(settings)
    store = get_model_store()
    store.load()
    # Anomaly model is optional on startup (non-fatal if not yet trained).
    try:
        anomaly_store = get_anomaly_store()
        anomaly_store.load()
    except Exception:  # pragma: no cover - defensive, must not block boot
        logger.warning("Anomaly model could not be loaded on startup")
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    is_production = os.getenv("NODE_ENV") == "production"
    if os.getenv("NODE_ENV") == "production" and not settings.internal_api_key:
        raise RuntimeError("INTERNAL_SERVICE_API_KEY must be configured in production")
    if is_production and not settings.cors_origins:
        raise RuntimeError("AI_CORS_ORIGINS must be configured in production")
    if is_production and any(origin == "*" for origin in settings.cors_origins):
        raise RuntimeError("AI_CORS_ORIGINS cannot contain '*' in production")
    if not settings.internal_api_key and not is_production:
        logger.warning(
            "INTERNAL_SERVICE_API_KEY is not set — non-health endpoints will reject requests until configured"
        )

    app = FastAPI(
        title=settings.app_name,
        description="AI Service for predicting energy generation and consumption using LSTM",
        version=settings.app_version,
        lifespan=lifespan,
        docs_url=None if is_production else "/docs",
        redoc_url=None if is_production else "/redoc",
        openapi_url=None if is_production else "/openapi.json",
    )

    app.middleware("http")(request_logging_middleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def internal_auth_middleware(request: Request, call_next):
        blocked = internal_auth_response(
            request.url.path,
            settings.internal_api_key,
            request.headers.get("x-internal-api-key"),
        )
        if blocked is not None:
            return blocked
        return await call_next(request)

    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(forecast.router)
    app.include_router(anomaly.router)
    app.include_router(models.router)

    return app

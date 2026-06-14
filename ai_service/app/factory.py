from contextlib import asynccontextmanager
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.dependencies import get_model_store
from app.handlers.exceptions import register_exception_handlers
from app.logging_config import setup_logging
from app.middleware import request_logging_middleware
from app.routers import forecast, health


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    setup_logging(settings)
    store = get_model_store()
    store.load()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    if os.getenv("NODE_ENV") == "production" and not settings.internal_api_key:
        raise RuntimeError("INTERNAL_SERVICE_API_KEY must be configured in production")

    app = FastAPI(
        title=settings.app_name,
        description="AI Service for predicting energy generation and consumption using LSTM",
        version=settings.app_version,
        lifespan=lifespan,
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
        if request.url.path.startswith("/health"):
            return await call_next(request)
        if settings.internal_api_key:
            provided = request.headers.get("x-internal-api-key")
            if provided != settings.internal_api_key:
                return JSONResponse(status_code=401, content={"detail": "Unauthorized internal request"})
        return await call_next(request)

    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(forecast.router)

    return app

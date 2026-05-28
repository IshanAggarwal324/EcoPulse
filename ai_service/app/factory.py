from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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

    app = FastAPI(
        title=settings.app_name,
        description="AI Service for predicting energy generation and consumption using LSTM",
        version=settings.app_version,
        lifespan=lifespan,
    )

    app.middleware("http")(request_logging_middleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(forecast.router)

    return app

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import health, reports
from app.services.llm_service import LlmService


def create_app() -> FastAPI:
    settings = get_settings()

    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )

    app = FastAPI(
        title=settings.app_name,
        description="GenAI service for EcoPulse — chat assistant and report narration via Gemini",
        version=settings.app_version,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    def _init_services():
        app.state.llm_service = LlmService(settings)

    app.include_router(health.router)
    app.include_router(reports.router)

    return app

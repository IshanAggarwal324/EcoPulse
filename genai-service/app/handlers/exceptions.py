import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import get_settings

logger = logging.getLogger(__name__)


def register_exception_handlers(app: FastAPI) -> None:
    settings = get_settings()

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("Unhandled error on %s", request.url.path)
        details = str(exc) if settings.debug and os.getenv("NODE_ENV") != "production" else None
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "message": "Internal server error",
                "error_code": "INTERNAL_ERROR",
                "details": details,
            },
        )

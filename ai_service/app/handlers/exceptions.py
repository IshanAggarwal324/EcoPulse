import logging
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.exceptions import AppError
from app.schemas import ErrorResponse

logger = logging.getLogger(__name__)


def _error_payload(
    message: str,
    error_code: str,
    details=None,
    status_code: int = 500,
) -> JSONResponse:
    body = ErrorResponse(
        message=message,
        error_code=error_code,
        details=details,
    )
    return JSONResponse(status_code=status_code, content=body.model_dump())


def register_exception_handlers(app: FastAPI) -> None:
    settings = get_settings()

    @app.exception_handler(AppError)
    async def app_error_handler(_request: Request, exc: AppError):
        logger.warning("AppError [%s]: %s", exc.error_code, exc.message)
        return _error_payload(
            message=exc.message,
            error_code=exc.error_code,
            details=exc.details,
            status_code=exc.status_code,
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request: Request, exc: HTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            message = detail.get("message", "Request failed")
            error_code = detail.get("error_code", "HTTP_ERROR")
            details = detail.get("details", detail)
        else:
            message = str(detail)
            error_code = "HTTP_ERROR"
            details = None

        return _error_payload(
            message=message,
            error_code=error_code,
            details=details,
            status_code=exc.status_code,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(_request: Request, exc: RequestValidationError):
        return _error_payload(
            message="Request validation failed",
            error_code="VALIDATION_ERROR",
            details=exc.errors(),
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("Unhandled error on %s", request.url.path)
        details = str(exc) if settings.debug and not (os.getenv("NODE_ENV") == "production") else None
        return _error_payload(
            message="Internal server error",
            error_code="INTERNAL_ERROR",
            details=details,
            status_code=500,
        )

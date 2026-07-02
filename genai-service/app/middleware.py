import logging
import time

from fastapi import Request

from app.logging_config import correlation_context, resolve_request_correlation_id

logger = logging.getLogger("ecopulse.access")


async def request_logging_middleware(request: Request, call_next):
    """Structured access log + end-to-end correlation (Module 7.3 / 7.4).

    genai-service previously had no request logging at all. Resolves an inbound
    ``x-request-id`` (sanitized — control chars stripped, length bounded — so an
    attacker cannot forge log lines or inject headers) or generates a UUID when
    it is absent/invalid. The id is bound to the logging contextvar for the
    request lifetime and echoed on the response for cross-service correlation.

    Uses ``request.url.path`` (no query string) so request parameters are never
    logged.
    """
    correlation_id = resolve_request_correlation_id(request.headers.get("x-request-id"))
    start = time.perf_counter()
    try:
        with correlation_context(correlation_id):
            response = await call_next(request)
    except Exception:
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.error(
            "%s %s -> 500 (unhandled)",
            request.method,
            request.url.path,
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": 500,
                "durationMs": round(elapsed_ms, 2),
            },
        )
        raise

    elapsed_ms = (time.perf_counter() - start) * 1000
    response.headers["x-request-id"] = correlation_id
    logger.info(
        "%s %s -> %s",
        request.method,
        request.url.path,
        response.status_code,
        extra={
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "durationMs": round(elapsed_ms, 2),
        },
    )
    return response

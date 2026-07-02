import logging
import time

from fastapi import Request

logger = logging.getLogger("ecopulse.access")


async def request_logging_middleware(request: Request, call_next):
    """Structured access log per request (Module 7.3).

    Uses ``request.url.path`` (no query string) so request parameters are never
    logged. genai-service previously had no request logging at all.
    """
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
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

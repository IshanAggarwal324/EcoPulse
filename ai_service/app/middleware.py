import logging
import time

from fastapi import Request

from app import metrics
from app.logging_config import (
    correlation_context,
    resolve_request_correlation_id,
    resolve_traceparent,
)

logger = logging.getLogger("ecopulse.access")


async def request_logging_middleware(request: Request, call_next):
    """Structured access log + end-to-end correlation (Module 7.3 / 7.4 / 7.6).

    Resolves an inbound ``x-request-id`` (sanitized — control chars stripped,
    length bounded — so an attacker cannot forge log lines or inject headers)
    or generates a UUID when it is absent/invalid. The id is bound to the
    logging contextvar for the request lifetime (so every log line carries it)
    and echoed on the response so callers can correlate logs across services.

    Module 7.6 — also resolves/propagates the W3C ``traceparent`` header
    alongside ``x-request-id`` (strictly validated; an invalid value is replaced
    with a freshly generated trace context so header injection / log forging is
    impossible).

    Module 7.5 — records Prometheus HTTP counters/histograms using the matched
    route template as the path label (cardinality-bounded).

    Uses ``request.url.path`` (no query string) so request parameters are never
    logged.
    """
    correlation_id = resolve_request_correlation_id(request.headers.get("x-request-id"))
    traceparent = resolve_traceparent(request.headers.get("traceparent"))
    start = time.perf_counter()
    try:
        with correlation_context(correlation_id, traceparent):
            response = await call_next(request)
    except Exception:
        # Defensive: an unhandled error (e.g. raised inside a middleware) still
        # gets a traceable access log + metric with the correlation id before
        # re-raising.
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
        metrics.record_http_request(
            request.method,
            metrics.normalize_route(request),
            500,
            elapsed_ms / 1000.0,
        )
        raise

    elapsed_ms = (time.perf_counter() - start) * 1000
    response.headers["x-request-id"] = correlation_id
    if traceparent:
        response.headers["traceparent"] = traceparent
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
            **({"traceId": traceparent.split("-")[1]} if traceparent and "-" in traceparent else {}),
        },
    )
    metrics.record_http_request(
        request.method,
        metrics.normalize_route(request),
        response.status_code,
        elapsed_ms / 1000.0,
    )
    return response

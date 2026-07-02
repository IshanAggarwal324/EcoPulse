"""Prometheus scrape endpoint for genai-service (Module 7.5).

GET /metrics emits the text exposition format. The route is exempt from the
internal API-key gate (handled in app.internal_auth) but is protected by
METRICS_TOKEN and disabled in production when no token is configured.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from app import metrics
from app.config import get_settings

router = APIRouter(tags=["Metrics"])
logger = logging.getLogger(__name__)


@router.get("/metrics")
async def get_metrics(request: Request):
    if not metrics.metrics_enabled():
        return PlainTextResponse("Not Found", status_code=404)

    if not metrics.is_authorized(
        request.headers.get("authorization"),
        request.headers.get("x-metrics-token"),
    ):
        return PlainTextResponse("Unauthorized", status_code=401)

    settings = get_settings()
    metrics.gauge("ecopulse_genai_available", 1 if settings.genai_available else 0)

    rag = getattr(request.app.state, "doc_rag_service", None)
    try:
        chunks = rag.docs_loaded_count if rag is not None else 0
    except Exception:  # pragma: no cover - defensive: never break a scrape
        logger.warning("Could not read doc RAG chunk count for metrics", exc_info=True)
        chunks = 0
    metrics.gauge("ecopulse_doc_chunks_loaded", max(0, int(chunks or 0)))

    return PlainTextResponse(
        metrics.render(),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )

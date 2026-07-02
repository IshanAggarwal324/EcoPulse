"""Prometheus scrape endpoint for ai_service (Module 7.5).

GET /metrics emits the text exposition format. The route is exempt from the
internal API-key gate (handled in app.internal_auth) but is protected by
METRICS_TOKEN and disabled in production when no token is configured.

The model store is imported lazily inside the handler so importing this router
never pulls in the (heavy) model store / TensorFlow — the route stays cheap to
mount and unit-testable.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from app import metrics

router = APIRouter(tags=["Metrics"])
logger = logging.getLogger(__name__)


def _model_ready() -> bool:
    try:
        from app.dependencies import get_model_store

        return bool(getattr(get_model_store(), "is_ready", False))
    except Exception:  # pragma: no cover - defensive: never break a scrape
        return False


@router.get("/metrics")
async def get_metrics(request: Request):
    if not metrics.metrics_enabled():
        return PlainTextResponse("Not Found", status_code=404)

    if not metrics.is_authorized(
        request.headers.get("authorization"),
        request.headers.get("x-metrics-token"),
    ):
        return PlainTextResponse("Unauthorized", status_code=401)

    metrics.gauge("ecopulse_model_ready", 1 if _model_ready() else 0)

    return PlainTextResponse(
        metrics.render(),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )

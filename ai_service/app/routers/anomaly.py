"""Anomaly detection API (Module 4.1.5).

Endpoints:
  - POST /anomaly/score   score a single node's recent readings
  - POST /anomaly/batch   score several nodes (admin/assistant)
  - GET  /anomaly/health  readiness probe

Auth is enforced app-wide by the internal-api-key middleware in factory.py.
"""

import logging

from fastapi import APIRouter, Depends

from app.dependencies import get_anomaly_service
from app.exceptions import ModelUnavailableError
from app import metrics
from app.schemas import (
    AnomalyBatchRequest,
    AnomalyBatchResponse,
    AnomalyFlaggedReading,
    AnomalyScoreRequest,
    AnomalyScoreResponse,
)
from app.services.anomaly_service import AnomalyService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/anomaly", tags=["Anomaly"])


@router.get("/health")
async def anomaly_health(service: AnomalyService = Depends(get_anomaly_service)):
    return {
        "status": "ok",
        "model_ready": service.is_ready(),
        "model_version": service.model_version,
    }


@router.post("/score", response_model=AnomalyScoreResponse)
async def score_readings(
    payload: AnomalyScoreRequest,
    service: AnomalyService = Depends(get_anomaly_service),
):
    if not service.is_ready():
        raise ModelUnavailableError("Anomaly model is not loaded")
    result = await service.score_readings(payload.node_id, payload.window_days)
    metrics.record_inference("anomaly")
    return AnomalyScoreResponse(
        node_id=result["node_id"],
        window_days=result["window_days"],
        model_status="ready",
        model_version=result.get("model_version"),
        total_readings=result["total_readings"],
        flagged_count=result["flagged_count"],
        flagged=[AnomalyFlaggedReading(**f) for f in result["flagged"]],
    )


@router.post("/batch", response_model=AnomalyBatchResponse)
async def score_batch(
    payload: AnomalyBatchRequest,
    service: AnomalyService = Depends(get_anomaly_service),
):
    if not service.is_ready():
        raise ModelUnavailableError("Anomaly model is not loaded")
    raw_results = await service.batch_score(payload.node_ids, payload.window_days)
    results = []
    for r in raw_results:
        if "error" in r:
            results.append(
                AnomalyScoreResponse(
                    node_id=r["node_id"],
                    window_days=r["window_days"],
                    model_status="skipped",
                    total_readings=0,
                    flagged_count=0,
                    flagged=[],
                )
            )
            continue
        results.append(
            AnomalyScoreResponse(
                node_id=r["node_id"],
                window_days=r["window_days"],
                model_status="ready",
                model_version=r.get("model_version"),
                total_readings=r["total_readings"],
                flagged_count=r["flagged_count"],
                flagged=[AnomalyFlaggedReading(**f) for f in r["flagged"]],
            )
        )
    metrics.record_inference("anomaly")
    return AnomalyBatchResponse(results=results, model_status="ready")

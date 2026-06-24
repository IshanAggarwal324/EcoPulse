"""Model registry, comparison, promotion, and drift surface (Module 4.2.7).

All endpoints sit behind the global internal-API-key middleware (service-to-
service). User-facing role enforcement happens in the Node.js backend admin
route that proxies these. Every externally-supplied ``version`` is validated
against a strict regex to prevent path traversal in the registry loader.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import asdict
from typing import Optional

from fastapi import APIRouter, Depends, Query

from app.config import get_settings
from app.dependencies import get_drift_monitor, get_model_store
from app.exceptions import AppError
from app.schemas import (
    DriftReportResponse,
    ModelCompareResponse,
    ModelVersionsResponse,
    PromoteModelRequest,
)
from app.services.drift_monitor import DriftMonitor
from app.services.model_store import ModelStore
from models.metrics import aggregate_mape
from models.model_registry import (
    get_latest,
    list_versions,
    read_metadata,
    set_latest,
)
from utils.database import modelcomparisons_collection

router = APIRouter(prefix="/models", tags=["Models"])
logger = logging.getLogger(__name__)

_VERSION_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def _validate_version(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    if not _VERSION_RE.match(value):
        raise AppError(
            "Invalid model_version",
            status_code=400,
            error_code="INVALID_MODEL_VERSION",
        )
    return value


@router.get("/versions", response_model=ModelVersionsResponse)
async def list_model_versions(model_store: ModelStore = Depends(get_model_store)):
    settings = get_settings()
    latest = get_latest(os.path.join(settings.registry_dir, settings.registry_model_name))
    versions = list_versions(
        registry_dir=settings.registry_dir,
        model_name=settings.registry_model_name,
    )
    return ModelVersionsResponse(latest_version=latest, versions=versions)


@router.get("/compare", response_model=ModelCompareResponse)
async def compare_versions(
    versionA: str = Query(..., description="First version"),
    versionB: str = Query(..., description="Second version"),
    nodeId: Optional[str] = Query(default=None, max_length=128),
):
    a = _validate_version(versionA)
    b = _validate_version(versionB)
    settings = get_settings()

    meta_a = read_metadata(
        registry_dir=settings.registry_dir,
        model_name=settings.registry_model_name,
        version=a,
    )
    meta_b = read_metadata(
        registry_dir=settings.registry_dir,
        model_name=settings.registry_model_name,
        version=b,
    )

    mape_a = aggregate_mape(meta_a.get("metrics", {}))
    mape_b = aggregate_mape(meta_b.get("metrics", {}))

    # Live comparison stats from reconciled A/B records, scoped to a node if given.
    match: dict = {"reconciled": True, "champion_mape": {"$ne": None}, "challenger_mape": {"$ne": None}}
    if nodeId:
        match["node_id"] = nodeId
    live = await modelcomparisons_collection.find(match).to_list(length=1000)

    champ_mapes = [float(d["champion_mape"]) for d in live if d.get("champion_mape") is not None]
    chal_mapes = [float(d["challenger_mape"]) for d in live if d.get("challenger_mape") is not None]

    def _mean(xs: list[float]) -> Optional[float]:
        return (sum(xs) / len(xs)) if xs else None

    return ModelCompareResponse(
        versionA=a,
        versionB=b,
        versionA_mape=mape_a,
        versionB_mape=mape_b,
        mape_delta=(mape_b - mape_a) if (mape_a is not None and mape_b is not None) else None,
        live_champion_mape=_mean(champ_mapes),
        live_challenger_mape=_mean(chal_mapes),
        live_samples=len(live),
        versionA_conformal=(meta_a.get("metrics", {}) or {}).get("conformal"),
        versionB_conformal=(meta_b.get("metrics", {}) or {}).get("conformal"),
    )


@router.post("/promote")
async def promote_model(
    request: PromoteModelRequest,
    model_store: ModelStore = Depends(get_model_store),
):
    version = _validate_version(request.version)
    settings = get_settings()
    # Confirm the version actually exists before promoting.
    try:
        read_metadata(
            registry_dir=settings.registry_dir,
            model_name=settings.registry_model_name,
            version=version,
        )
    except FileNotFoundError:
        raise AppError(
            f"Model version not found: {version}",
            status_code=404,
            error_code="MODEL_VERSION_NOT_FOUND",
        )

    set_latest(os.path.join(settings.registry_dir, settings.registry_model_name), version)
    logger.info("Promoted model version %s to LATEST", version)
    return {"promoted": True, "version": version}


@router.get("/drift", response_model=DriftReportResponse)
async def drift_status(drift: DriftMonitor = Depends(get_drift_monitor)):
    report = await drift.check_drift()
    return DriftReportResponse(**asdict(report))

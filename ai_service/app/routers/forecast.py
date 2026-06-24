import asyncio
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, Query

from app.dependencies import get_ab_test_service, get_forecast_service, get_model_store
from app.exceptions import AppError, ModelUnavailableError
from app.schemas import (
    BatchForecastRequest,
    BatchForecastResponse,
    ConfidenceResponse,
    ForecastRequest,
    ForecastResponse,
)
from app.services.ab_test_service import ABTestService, schedule_shadow_log
from app.services.forecast_service import ForecastService
from app.services.model_store import ModelStore
from app.services import forecast_cache

router = APIRouter(prefix="/forecast", tags=["Forecast"])
logger = logging.getLogger(__name__)

MODEL_STATUS = "Using pre-trained production model"
FALLBACK_STATUS = "Using heuristic fallback (model unavailable)"

_VERSION_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")

# Retain references to background A/B shadow-logging tasks so they are not
# garbage-collected mid-execution (asyncio does not hold strong refs).
_background_tasks: set[asyncio.Task] = set()


def _spawn_background(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def _validate_version(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if not _VERSION_RE.match(value):
        raise AppError(
            "Invalid model_version",
            status_code=400,
            error_code="INVALID_MODEL_VERSION",
        )
    return value


def _ensure_model_loaded(store: ModelStore) -> bool:
    if not store.is_ready:
        store.load()
    return store.is_ready


def _resolve_served_version(request: ForecastRequest, ab: ABTestService) -> Optional[str]:
    """Pick the model version to serve for this request.

    An explicit ``model_version`` always wins. Otherwise, if A/B is enabled, a
    deterministic per-node hash may route the request to the challenger.
    """
    if request.model_version:
        return request.model_version
    if ab.enabled:
        return ab.resolve_assignment(request.node_id)
    return None


@router.post("/", response_model=ForecastResponse)
async def get_forecast(
    request: ForecastRequest,
    forecast_service: ForecastService = Depends(get_forecast_service),
    model_store: ModelStore = Depends(get_model_store),
    ab: ABTestService = Depends(get_ab_test_service),
):
    served_version = _resolve_served_version(request, ab)
    cache_payload = {**request.model_dump(), "served_version": served_version}
    cached = forecast_cache.get_cached("forecast", cache_payload)
    if cached is not None:
        return ForecastResponse(**cached)

    model_status = MODEL_STATUS
    try:
        if served_version is not None:
            results = await forecast_service.predict(
                request.days_to_predict,
                request.use_dummy_data,
                request.node_id,
                served_version,
            )
        elif _ensure_model_loaded(model_store):
            results = await forecast_service.predict(
                request.days_to_predict,
                request.use_dummy_data,
                request.node_id,
                None,
            )
        elif forecast_service.allow_model_free_dummy:
            logger.warning(
                "Model unavailable; serving heuristic fallback forecast (node=%s, requested_dummy=%s)",
                request.node_id or "aggregate",
                request.use_dummy_data,
            )
            results = await forecast_service.predict_without_model(
                request.days_to_predict,
                request.use_dummy_data,
                request.node_id,
            )
            model_status = FALLBACK_STATUS
        else:
            raise ModelUnavailableError()
    except ModelUnavailableError:
        # Only fall back to the heuristic when no specific version was served.
        if served_version is None and forecast_service.allow_model_free_dummy:
            results = await forecast_service.predict_without_model(
                request.days_to_predict,
                request.use_dummy_data,
                request.node_id,
            )
            model_status = FALLBACK_STATUS
        else:
            raise

    resolved_version = model_store.resolved_version(served_version)
    response_payload = {
        "predictions": results,
        "model_status": model_status,
        "model_version": resolved_version,
        "node_id": request.node_id,
    }
    forecast_cache.set_cached("forecast", cache_payload, response_payload)

    # Fire-and-forget: when the challenger is served on an organic request,
    # also score the champion and log both for offline comparison.
    if served_version and request.model_version is None and ab.enabled:
        _spawn_background(
            schedule_shadow_log(
                ab,
                forecast_service,
                node_id=request.node_id,
                days_to_predict=request.days_to_predict,
                use_dummy_data=request.use_dummy_data,
                champion_version=model_store.resolved_version(None),
                challenger_version=served_version,
                challenger_predictions=results,
            )
        )

    return ForecastResponse(**response_payload)


@router.get("/confidence", response_model=ConfidenceResponse)
async def get_confidence(
    model_version: Optional[str] = Query(default=None, max_length=64),
    model_store: ModelStore = Depends(get_model_store),
):
    version = _validate_version(model_version)
    if version is None:
        _ensure_model_loaded(model_store)
    model, scaler, metadata, resolved = model_store.get_version(version)

    metrics = (metadata or {}).get("metrics", {}) or {}
    conformal = metrics.get("conformal", {}) or {}
    uncertainty_method = "conformal" if conformal else "heuristic"

    return ConfidenceResponse(
        model_version=resolved,
        uncertainty_method=uncertainty_method,
        alpha=conformal.get("alpha"),
        calibration_metrics=conformal,
        mape_generation=metrics.get("mape_generation"),
        mape_consumption=metrics.get("mape_consumption"),
        rmse_generation=metrics.get("rmse_generation"),
        rmse_consumption=metrics.get("rmse_consumption"),
        n_samples=metrics.get("n_samples"),
    )


@router.post("/batch", response_model=BatchForecastResponse)
async def get_batch_forecast(
    request: BatchForecastRequest,
    forecast_service: ForecastService = Depends(get_forecast_service),
    model_store: ModelStore = Depends(get_model_store),
):
    cache_payload = request.model_dump()
    cached = forecast_cache.get_cached("batch", cache_payload)
    if cached is not None:
        return BatchForecastResponse(**cached)

    model_ready = _ensure_model_loaded(model_store)
    model_status = MODEL_STATUS

    if model_ready:
        forecasts, _errors = await forecast_service.predict_batch(
            request.node_ids,
            request.days_to_predict,
            request.use_dummy_data,
        )
    elif forecast_service.allow_model_free_dummy:
        logger.warning(
            "Model unavailable; serving heuristic batch fallback forecast (requested_dummy=%s)",
            request.use_dummy_data,
        )
        forecasts, _errors = await forecast_service.predict_batch_without_model(
            request.node_ids,
            request.days_to_predict,
            request.use_dummy_data,
        )
        model_status = FALLBACK_STATUS
    else:
        raise ModelUnavailableError()

    response_payload = {
        "forecasts": forecasts,
        "model_status": model_status,
        "model_version": model_store.resolved_version(None),
    }
    forecast_cache.set_cached("batch", cache_payload, response_payload)
    return BatchForecastResponse(**response_payload)

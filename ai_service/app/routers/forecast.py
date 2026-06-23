import logging

from fastapi import APIRouter, Depends

from app.dependencies import get_forecast_service, get_model_store
from app.exceptions import ModelUnavailableError
from app.schemas import (
    BatchForecastRequest,
    BatchForecastResponse,
    ForecastRequest,
    ForecastResponse,
)
from app.services.forecast_service import ForecastService
from app.services.model_store import ModelStore
from app.services import forecast_cache

router = APIRouter(prefix="/forecast", tags=["Forecast"])
logger = logging.getLogger(__name__)

MODEL_STATUS = "Using pre-trained production model"
FALLBACK_STATUS = "Using heuristic fallback (model unavailable)"


def _ensure_model_loaded(store: ModelStore) -> bool:
    if not store.is_ready:
        store.load()
    return store.is_ready


@router.post("/", response_model=ForecastResponse)
async def get_forecast(
    request: ForecastRequest,
    forecast_service: ForecastService = Depends(get_forecast_service),
    model_store: ModelStore = Depends(get_model_store),
):
    cache_payload = request.model_dump()
    cached = forecast_cache.get_cached("forecast", cache_payload)
    if cached is not None:
        return ForecastResponse(**cached)

    model_ready = _ensure_model_loaded(model_store)
    model_status = MODEL_STATUS

    if model_ready:
        results = await forecast_service.predict(
            request.days_to_predict,
            request.use_dummy_data,
            request.node_id,
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

    response_payload = {
        "predictions": results,
        "model_status": model_status,
        "node_id": request.node_id,
    }
    forecast_cache.set_cached("forecast", cache_payload, response_payload)
    return ForecastResponse(**response_payload)


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
    }
    forecast_cache.set_cached("batch", cache_payload, response_payload)
    return BatchForecastResponse(**response_payload)

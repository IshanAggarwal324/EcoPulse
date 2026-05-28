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

router = APIRouter(prefix="/forecast", tags=["Forecast"])
logger = logging.getLogger(__name__)

MODEL_STATUS = "Using pre-trained production model"


def _ensure_model_loaded(store: ModelStore) -> None:
    if not store.is_ready:
        store.load()
    if not store.is_ready:
        raise ModelUnavailableError()


@router.post("/", response_model=ForecastResponse)
async def get_forecast(
    request: ForecastRequest,
    forecast_service: ForecastService = Depends(get_forecast_service),
    model_store: ModelStore = Depends(get_model_store),
):
    _ensure_model_loaded(model_store)
    results = await forecast_service.predict(
        request.days_to_predict,
        request.use_dummy_data,
        request.node_id,
    )
    return ForecastResponse(
        predictions=results,
        model_status=MODEL_STATUS,
        node_id=request.node_id,
    )


@router.post("/batch", response_model=BatchForecastResponse)
async def get_batch_forecast(
    request: BatchForecastRequest,
    forecast_service: ForecastService = Depends(get_forecast_service),
    model_store: ModelStore = Depends(get_model_store),
):
    _ensure_model_loaded(model_store)
    forecasts, _errors = await forecast_service.predict_batch(
        request.node_ids,
        request.days_to_predict,
        request.use_dummy_data,
    )
    return BatchForecastResponse(forecasts=forecasts, model_status=MODEL_STATUS)

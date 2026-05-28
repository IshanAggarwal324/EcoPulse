from functools import lru_cache

from app.config import Settings, get_settings
from app.services.forecast_service import ForecastService
from app.services.model_store import ModelStore


@lru_cache
def get_model_store() -> ModelStore:
    settings = get_settings()
    return ModelStore(settings)


def get_forecast_service() -> ForecastService:
    settings = get_settings()
    store = get_model_store()
    return ForecastService(store, settings)

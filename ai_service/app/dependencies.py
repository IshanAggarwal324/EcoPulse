from functools import lru_cache

from app.config import Settings, get_settings
from app.services.ab_test_service import ABTestService
from app.services.anomaly_service import AnomalyService
from app.services.anomaly_store import AnomalyStore
from app.services.drift_monitor import DriftMonitor
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


@lru_cache
def get_anomaly_store() -> AnomalyStore:
    settings = get_settings()
    return AnomalyStore(settings)


def get_anomaly_service() -> AnomalyService:
    settings = get_settings()
    store = get_anomaly_store()
    return AnomalyService(store, settings)


@lru_cache
def get_ab_test_service() -> ABTestService:
    return ABTestService(get_settings())


@lru_cache
def get_drift_monitor() -> DriftMonitor:
    return DriftMonitor(get_settings())

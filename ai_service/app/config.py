import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

from app.env_utils import resolve_debug_flag


def _parse_origins(value: str) -> list[str]:
    return [origin.strip() for origin in value.split(",") if origin.strip()]


def _clamp_pct(raw: str, default: float = 0.0) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not (0.0 <= value <= 100.0):
        return default
    return value


def _clamp_alpha(raw: str, default: float = 0.1) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return min(0.5, max(0.01, value))


def _clamp_int(raw: str, low: int, high: int, default: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return min(high, max(low, value))


def _parse_horizons(raw: str) -> tuple[int, ...]:
    """Parse a comma list of positive integer horizons (1..365), deduped/sorted."""
    out: list[int] = []
    seen: set[int] = set()
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except ValueError:
            continue
        if 1 <= value <= 365 and value not in seen:
            seen.add(value)
            out.append(value)
    return tuple(sorted(out)) or (1, 7, 14, 30)


@dataclass(frozen=True)
class Settings:
    app_name: str = "EcoPulse AI Service"
    app_version: str = "1.0.0"
    debug: bool = False

    model_dir: str = "models/saved"
    model_filename: str = "lstm_model.keras"
    scaler_filename: str = "scaler.save"
    registry_dir: str = "models/registry"
    registry_model_name: str = "lstm_energy_forecast"
    registry_version: Optional[str] = None
    allow_model_free_dummy: bool = False
    look_back_days: int = 30
    history_days: int = 60

    anomaly_registry_model_name: str = "meter_anomaly_detector"
    anomaly_registry_version: Optional[str] = None
    anomaly_feature_window: int = 7
    anomaly_score_threshold: float = 0.7
    anomaly_zscore_cap: float = 3.0
    anomaly_contamination: float = 0.05
    anomaly_max_results: int = 500

    mongo_uri: str = "mongodb://localhost:27017"
    port: int = 8000
    host: str = "127.0.0.1"
    cors_origins: tuple[str, ...] = ()
    internal_api_key: str = ""
    log_level: str = "INFO"
    log_file: str = "app.log"

    # Module 4.2 — retrain pipeline, uncertainty calibration, A/B, drift.
    conformal_alpha: float = 0.1
    retrain_min_days: int = 30
    retrain_min_nodes: int = 1
    retrain_history_days: int = 365
    retrain_mape_improvement: float = 0.02
    drift_window_days: int = 14
    drift_mape_threshold: float = 0.5
    ab_enabled: bool = False
    ab_champion_version: Optional[str] = None
    ab_challenger_version: Optional[str] = None
    ab_traffic_pct: float = 0.0

    # Module 4.3 — per-node multi-horizon forecasting.
    forecast_horizons: tuple[int, ...] = (1, 7, 14, 30)
    default_horizon: int = 30
    node_min_history_days: int = 60
    node_max_train_per_run: int = 50
    per_node_training_enabled: bool = False

    @property
    def model_path(self) -> str:
        return os.path.join(self.model_dir, self.model_filename)

    @property
    def scaler_path(self) -> str:
        return os.path.join(self.model_dir, self.scaler_filename)


@lru_cache
def get_settings() -> Settings:
    return Settings(
        debug=resolve_debug_flag(),
        model_dir=os.getenv("MODEL_DIR", "models/saved"),
        model_filename=os.getenv("MODEL_FILENAME", "lstm_model.keras"),
        scaler_filename=os.getenv("SCALER_FILENAME", "scaler.save"),
        registry_dir=os.getenv("ECOPULSE_MODEL_REGISTRY_DIR", "models/registry"),
        registry_model_name=os.getenv("ECOPULSE_MODEL_NAME", "lstm_energy_forecast"),
        registry_version=os.getenv("ECOPULSE_MODEL_VERSION") or None,
        allow_model_free_dummy=os.getenv(
            "ALLOW_MODEL_FREE_DUMMY", ""
        ).lower() in ("1", "true", "yes"),
        mongo_uri=os.getenv(
            "MONGODB_URI", os.getenv("MONGO_URI", "mongodb://localhost:27017")
        ),
        port=int(os.getenv("PORT", "8000")),
        host=os.getenv("AI_HOST", "127.0.0.1"),
        cors_origins=tuple(_parse_origins(os.getenv("AI_CORS_ORIGINS", ""))),
        internal_api_key=os.getenv("INTERNAL_SERVICE_API_KEY", ""),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        log_file=os.getenv("LOG_FILE", "app.log"),
        look_back_days=int(os.getenv("LOOK_BACK_DAYS", "30")),
        history_days=int(os.getenv("HISTORY_DAYS", "60")),
        anomaly_registry_model_name=os.getenv(
            "ECOPULSE_ANOMALY_MODEL_NAME", "meter_anomaly_detector"
        ),
        anomaly_registry_version=os.getenv("ECOPULSE_ANOMALY_MODEL_VERSION") or None,
        anomaly_feature_window=int(os.getenv("ANOMALY_FEATURE_WINDOW", "7")),
        anomaly_score_threshold=float(os.getenv("ANOMALY_SCORE_THRESHOLD", "0.7")),
        anomaly_zscore_cap=float(os.getenv("ANOMALY_ZSCORE_CAP", "3.0")),
        anomaly_contamination=float(os.getenv("ANOMALY_CONTAMINATION", "0.05")),
        anomaly_max_results=int(os.getenv("ANOMALY_MAX_RESULTS", "500")),
        conformal_alpha=_clamp_alpha(os.getenv("ECOPULSE_CONFORMAL_ALPHA", "0.1")),
        retrain_min_days=int(os.getenv("ECOPULSE_RETRAIN_MIN_DAYS", "30")),
        retrain_min_nodes=int(os.getenv("ECOPULSE_RETRAIN_MIN_NODES", "1")),
        retrain_history_days=int(os.getenv("ECOPULSE_RETRAIN_HISTORY_DAYS", "365")),
        retrain_mape_improvement=float(os.getenv("ECOPULSE_RETRAIN_MAPE_IMPROVEMENT", "0.02")),
        drift_window_days=int(os.getenv("ECOPULSE_DRIFT_WINDOW_DAYS", "14")),
        drift_mape_threshold=float(os.getenv("ECOPULSE_DRIFT_MAPE_THRESHOLD", "0.5")),
        ab_enabled=os.getenv("ECOPULSE_AB_ENABLED", "").lower() in ("1", "true", "yes"),
        ab_champion_version=os.getenv("ECOPULSE_AB_CHAMPION") or None,
        ab_challenger_version=os.getenv("ECOPULSE_AB_CHALLENGER") or None,
        ab_traffic_pct=_clamp_pct(os.getenv("ECOPULSE_AB_TRAFFIC_PCT", "0")),
        forecast_horizons=_parse_horizons(os.getenv("ECOPULSE_FORECAST_HORIZONS", "1,7,14,30")),
        default_horizon=_clamp_int(os.getenv("ECOPULSE_DEFAULT_HORIZON", "30"), 1, 365, 30),
        node_min_history_days=_clamp_int(os.getenv("ECOPULSE_NODE_MIN_HISTORY_DAYS", "60"), 1, 3650, 60),
        node_max_train_per_run=_clamp_int(os.getenv("ECOPULSE_NODE_MAX_TRAIN_PER_RUN", "50"), 1, 1000, 50),
        per_node_training_enabled=os.getenv("ECOPULSE_PER_NODE_TRAIN", "").lower() in ("1", "true", "yes"),
    )

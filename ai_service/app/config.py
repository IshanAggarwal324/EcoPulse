import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

from app.env_utils import resolve_debug_flag


def _parse_origins(value: str) -> list[str]:
    return [origin.strip() for origin in value.split(",") if origin.strip()]


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

    mongo_uri: str = "mongodb://localhost:27017"
    port: int = 8000
    host: str = "127.0.0.1"
    cors_origins: tuple[str, ...] = ()
    internal_api_key: str = ""
    log_level: str = "INFO"
    log_file: str = "app.log"

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
    )

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Settings:
    app_name: str = "EcoPulse AI Service"
    app_version: str = "1.0.0"
    debug: bool = False

    model_dir: str = "models/saved"
    model_filename: str = "lstm_model.keras"
    scaler_filename: str = "scaler.save"
    look_back_days: int = 30
    history_days: int = 60

    mongo_uri: str = "mongodb://localhost:27017"
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
        debug=os.getenv("DEBUG", "false").lower() in ("1", "true", "yes"),
        model_dir=os.getenv("MODEL_DIR", "models/saved"),
        mongo_uri=os.getenv(
            "MONGODB_URI", os.getenv("MONGO_URI", "mongodb://localhost:27017")
        ),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        log_file=os.getenv("LOG_FILE", "app.log"),
        look_back_days=int(os.getenv("LOOK_BACK_DAYS", "30")),
        history_days=int(os.getenv("HISTORY_DAYS", "60")),
    )

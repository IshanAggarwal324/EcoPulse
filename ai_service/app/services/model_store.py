import logging
import joblib
from tensorflow.keras.models import load_model

from app.config import Settings
from app.exceptions import ModelUnavailableError
from models.model_registry import load_bundle

logger = logging.getLogger(__name__)


class ModelStore:
    """Loads and holds the LSTM model and scaler artifacts."""

    def __init__(self, settings: Settings):
        self._settings = settings
        self._model = None
        self._scaler = None
        self._load_error: str | None = None

    @property
    def is_ready(self) -> bool:
        return self._model is not None and self._scaler is not None

    @property
    def model(self):
        self._ensure_ready()
        return self._model

    @property
    def scaler(self):
        self._ensure_ready()
        return self._scaler

    def load(self) -> None:
        if self.is_ready:
            return

        primary_error = None
        try:
            logger.info("Loading model from %s", self._settings.model_path)
            self._model = load_model(self._settings.model_path)
            self._scaler = joblib.load(self._settings.scaler_path)
            self._load_error = None
            logger.info("Model artifacts loaded successfully")
            return
        except Exception as exc:
            primary_error = str(exc)
            logger.warning(
                "Primary model artifacts not found/invalid (%s). "
                "Falling back to registry model loading.",
                exc,
            )

        try:
            model, scaler, metadata = load_bundle(
                registry_dir=self._settings.registry_dir,
                model_name=self._settings.registry_model_name,
                version=self._settings.registry_version,
            )
            self._model = model
            self._scaler = scaler
            self._load_error = None
            logger.info(
                "Loaded model artifacts from registry (model=%s, version=%s)",
                metadata.get("model_name", self._settings.registry_model_name),
                metadata.get("version", self._settings.registry_version or "LATEST"),
            )
        except Exception as exc:
            self._model = None
            self._scaler = None
            fallback_error = str(exc)
            self._load_error = (
                f"Primary load failed: {primary_error}. "
                f"Registry fallback failed: {fallback_error}"
            )
            logger.error("Failed to load model artifacts from primary and fallback paths.")

    def _ensure_ready(self) -> None:
        if not self.is_ready:
            raise ModelUnavailableError(details=self._load_error)

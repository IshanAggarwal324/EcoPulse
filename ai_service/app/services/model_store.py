import logging
import joblib
from tensorflow.keras.models import load_model

from app.config import Settings
from app.exceptions import ModelUnavailableError

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

        try:
            logger.info("Loading model from %s", self._settings.model_path)
            self._model = load_model(self._settings.model_path)
            self._scaler = joblib.load(self._settings.scaler_path)
            self._load_error = None
            logger.info("Model artifacts loaded successfully")
        except Exception as exc:
            self._model = None
            self._scaler = None
            self._load_error = str(exc)
            logger.error("Failed to load model artifacts: %s", exc)

    def _ensure_ready(self) -> None:
        if not self.is_ready:
            raise ModelUnavailableError(details=self._load_error)

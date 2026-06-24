"""Loads and holds the anomaly detector artifact (Module 4.1.3/4.1.4 wiring).

Mirrors ``model_store.ModelStore`` but targets the joblib-serialized anomaly
bundle. Load failures are non-fatal: the service still boots and reports the
model as unavailable rather than crashing the AI service on startup.
"""

import logging
from typing import Any, Dict, Optional

from app.config import Settings
from app.exceptions import ModelUnavailableError
from models.model_registry import load_anomaly_bundle

logger = logging.getLogger(__name__)


class AnomalyStore:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._model: Any = None
        self._feature_config: Dict[str, Any] = {}
        self._metadata: Dict[str, Any] = {}
        self._load_error: Optional[str] = None

    @property
    def is_ready(self) -> bool:
        return self._model is not None

    @property
    def model(self) -> Any:
        return self._model

    @property
    def feature_config(self) -> Dict[str, Any]:
        return dict(self._feature_config or {})

    @property
    def model_version(self) -> Optional[str]:
        return self._metadata.get("version")

    def load(self) -> None:
        try:
            model, feature_config, metadata = load_anomaly_bundle(
                registry_dir=self._settings.registry_dir,
                model_name=self._settings.anomaly_registry_model_name,
                version=self._settings.anomaly_registry_version,
            )
            self._model = model
            self._feature_config = feature_config or {}
            self._metadata = metadata or {}
            self._load_error = None
            logger.info(
                "Anomaly model loaded (model=%s version=%s)",
                self._settings.anomaly_registry_model_name,
                self.model_version,
            )
        except FileNotFoundError:
            self._load_error = "no anomaly model registered"
            logger.warning("Anomaly model not loaded: %s", self._load_error)
        except Exception as exc:  # pragma: no cover - defensive
            self._load_error = str(exc)
            logger.exception("Failed to load anomaly model")

    def ensure_ready(self) -> None:
        if not self.is_ready:
            raise ModelUnavailableError(
                f"Anomaly model unavailable: {self._load_error or 'not loaded'}"
            )

import logging
import joblib
from tensorflow.keras.models import load_model

from app.config import Settings
from app.exceptions import ModelUnavailableError
from models.model_registry import _assert_safe_component, load_bundle

logger = logging.getLogger(__name__)


class ModelStore:
    """Loads and holds the LSTM model and scaler artifacts.

    The default model (no explicit version) follows the existing dual-path
    strategy: the configured ``model.keras``/``scaler.save`` files, falling
    back to the registry LATEST. Explicit versions are loaded on demand from
    the registry and cached, so two registry versions can serve traffic
    simultaneously (Module 4.2.3 / 4.2.6).
    """

    def __init__(self, settings: Settings):
        self._settings = settings
        self._model = None
        self._scaler = None
        self._metadata: dict = {}
        self._version: str | None = None
        self._load_error: str | None = None
        self._versions: dict[str, tuple] = {}

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

    @property
    def metadata(self) -> dict:
        return self._metadata or {}

    def resolved_version(self, version: str | None = None) -> str | None:
        if version:
            return version
        return self._version

    def load(self) -> None:
        if self.is_ready:
            return

        primary_error = None
        try:
            logger.info("Loading model from %s", self._settings.model_path)
            self._model = load_model(self._settings.model_path)
            self._scaler = joblib.load(self._settings.scaler_path)
            self._metadata = {}
            self._version = None
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
            self._metadata = metadata or {}
            self._version = metadata.get("version", self._settings.registry_version)
            self._load_error = None
            logger.info(
                "Loaded model artifacts from registry (model=%s, version=%s)",
                metadata.get("model_name", self._settings.registry_model_name),
                metadata.get("version", self._settings.registry_version or "LATEST"),
            )
        except Exception as exc:
            self._model = None
            self._scaler = None
            self._metadata = {}
            self._version = None
            fallback_error = str(exc)
            self._load_error = (
                f"Primary load failed: {primary_error}. "
                f"Registry fallback failed: {fallback_error}"
            )
            logger.error("Failed to load model artifacts from primary and fallback paths.")

    def get_version(self, version: str | None = None):
        """Return (model, scaler, metadata, resolved_version).

        ``version=None`` resolves to the default (loaded) model. An explicit
        version is loaded from the registry on demand and cached. Path-safe
        validation prevents traversal outside the registry root.
        """
        if version is None:
            if not self.is_ready:
                self.load()
            if not self.is_ready:
                raise ModelUnavailableError(details=self._load_error)
            return self._model, self._scaler, self._metadata, self._version

        _assert_safe_component(version, "version")
        cached = self._versions.get(version)
        if cached is not None:
            return cached[0], cached[1], cached[2], version

        try:
            model, scaler, metadata = load_bundle(
                registry_dir=self._settings.registry_dir,
                model_name=self._settings.registry_model_name,
                version=version,
            )
        except FileNotFoundError as exc:
            raise ModelUnavailableError(details=str(exc))
        self._versions[version] = (model, scaler, metadata or {})
        logger.info("Loaded model version %s on demand", version)
        return model, scaler, metadata or {}, version

    def _ensure_ready(self) -> None:
        if not self.is_ready:
            raise ModelUnavailableError(details=self._load_error)

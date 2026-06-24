import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import joblib


DEFAULT_REGISTRY_DIR = os.getenv("ECOPULSE_MODEL_REGISTRY_DIR", "models/registry")
DEFAULT_MODEL_NAME = os.getenv("ECOPULSE_MODEL_NAME", "lstm_energy_forecast")
ANOMALY_MODEL_NAME = os.getenv("ECOPULSE_ANOMALY_MODEL_NAME", "meter_anomaly_detector")


def _assert_safe_component(value: str, label: str) -> str:
    """Reject registry path components that could escape the registry root
    (e.g. '..', '/' or '\\'). Registry names/versions originate from env and
    trusted callers, but defence-in-depth prevents path traversal on load."""
    if not value or not isinstance(value, str):
        raise ValueError(f"Invalid {label}: empty")
    if value in (".", "..") or "/" in value or "\\" in value or "\x00" in value:
        raise ValueError(f"Invalid {label}: must be a single path-safe segment")
    return value


def _utc_version() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _safe_mkdir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _latest_path(model_dir: str) -> str:
    return os.path.join(model_dir, "LATEST")


def set_latest(model_dir: str, version: str) -> None:
    _safe_mkdir(model_dir)
    with open(_latest_path(model_dir), "w", encoding="utf-8") as f:
        f.write(version.strip() + "\n")


def get_latest(model_dir: str) -> Optional[str]:
    try:
        with open(_latest_path(model_dir), "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except FileNotFoundError:
        return None


def get_model_version_dir(
    *,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
    version: str,
) -> str:
    return os.path.join(registry_dir, model_name, version)


def save_bundle(
    *,
    model,
    scaler,
    preprocessing_meta: Dict[str, Any],
    training_meta: Dict[str, Any],
    metrics: Optional[Dict[str, Any]] = None,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
    version: Optional[str] = None,
    promote: bool = True,
) -> str:
    """
    Saves a versioned bundle:
      - model.keras
      - scaler.joblib
      - metadata.json
    Updates <model_name>/LATEST only when ``promote=True`` (default).
    Returns the version string.
    """
    _assert_safe_component(model_name, "model_name")
    version = _assert_safe_component(version or _utc_version(), "version")
    model_root = os.path.join(registry_dir, model_name)
    version_dir = get_model_version_dir(
        registry_dir=registry_dir, model_name=model_name, version=version
    )
    _safe_mkdir(version_dir)

    model_path = os.path.join(version_dir, "model.keras")
    scaler_path = os.path.join(version_dir, "scaler.joblib")
    meta_path = os.path.join(version_dir, "metadata.json")

    model.save(model_path)
    joblib.dump(scaler, scaler_path)

    metadata = {
        "model_name": model_name,
        "version": version,
        "saved_at_utc": datetime.now(timezone.utc).isoformat(),
        "artifacts": {
            "model_path": model_path,
            "scaler_path": scaler_path,
        },
        "preprocessing": preprocessing_meta,
        "training": training_meta,
        "metrics": metrics or {},
    }

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, sort_keys=True)

    if promote:
        set_latest(model_root, version)
    return version


def read_metadata(
    *,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
    version: str,
) -> Dict[str, Any]:
    """Read and return a version's metadata.json (raises FileNotFoundError)."""
    _assert_safe_component(model_name, "model_name")
    _assert_safe_component(version, "version")
    version_dir = get_model_version_dir(
        registry_dir=registry_dir, model_name=model_name, version=version
    )
    meta_path = os.path.join(version_dir, "metadata.json")
    with open(meta_path, "r", encoding="utf-8") as f:
        return json.load(f)


def list_versions(
    *,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
) -> list[Dict[str, Any]]:
    """List every registered version with a lightweight summary.

    Only ``metadata.json`` is read (no model deserialization) so this is safe
    to call from request handlers. Version directories are validated before
    being read to prevent traversal.
    """
    _assert_safe_component(model_name, "model_name")
    model_root = os.path.join(registry_dir, model_name)
    if not os.path.isdir(model_root):
        return []

    summaries: list[Dict[str, Any]] = []
    for entry in os.listdir(model_root):
        entry_path = os.path.join(model_root, entry)
        if not os.path.isdir(entry_path):
            continue
        try:
            _assert_safe_component(entry, "version")
        except ValueError:
            continue
        meta_path = os.path.join(entry_path, "metadata.json")
        if not os.path.isfile(meta_path):
            continue
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        metrics = meta.get("metrics", {}) or {}
        summaries.append(
            {
                "version": meta.get("version", entry),
                "saved_at_utc": meta.get("saved_at_utc"),
                "data_source": (meta.get("training", {}) or {}).get("data_source"),
                "n_rows": (meta.get("preprocessing", {}) or {}).get("n_rows"),
                "mape_generation": metrics.get("mape_generation"),
                "mape_consumption": metrics.get("mape_consumption"),
                "promoted": meta.get("version") == get_latest(model_root),
            }
        )
    summaries.sort(key=lambda s: s.get("saved_at_utc") or "", reverse=True)
    return summaries


def load_bundle(
    *,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
    version: Optional[str] = None,
) -> Tuple[Any, Any, Dict[str, Any]]:
    """
    Loads model + scaler + metadata.
    If version is None, tries LATEST.
    """
    _assert_safe_component(model_name, "model_name")
    model_root = os.path.join(registry_dir, model_name)
    resolved = version or get_latest(model_root)
    if not resolved:
        raise FileNotFoundError(f"No model version found for '{model_name}'")
    _assert_safe_component(resolved, "version")

    version_dir = get_model_version_dir(
        registry_dir=registry_dir, model_name=model_name, version=resolved
    )
    model_path = os.path.join(version_dir, "model.keras")
    scaler_path = os.path.join(version_dir, "scaler.joblib")
    meta_path = os.path.join(version_dir, "metadata.json")

    try:
        from tensorflow.keras.models import load_model  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "TensorFlow/Keras is required to load the saved model. "
            "Run in a compatible Python environment with TensorFlow installed."
        ) from e

    model = load_model(model_path)
    scaler = joblib.load(scaler_path)

    metadata: Dict[str, Any] = {}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)
    except FileNotFoundError:
        metadata = {"model_name": model_name, "version": resolved}

    return model, scaler, metadata


# ---------------------------------------------------------------------------
# Anomaly model bundles (joblib-serialized, framework-agnostic)
#
# The LSTM bundle above is Keras-specific (model.save / load_model). The
# anomaly detector is a scikit-learn object, so it needs its own save/load
# pair that serializes the estimator and its feature_config via joblib.
# joblib uses pickle internally — only load artifacts from this trusted,
# write-controlled registry directory, never from user-supplied paths.
# ---------------------------------------------------------------------------


def save_anomaly_bundle(
    *,
    model,
    feature_config: Dict[str, Any],
    training_meta: Dict[str, Any],
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = ANOMALY_MODEL_NAME,
    version: Optional[str] = None,
) -> str:
    """
    Saves a versioned anomaly bundle:
      - model.joblib         (the fitted sklearn estimator)
      - feature_config.joblib (calibration params, feature list, thresholds)
      - metadata.json
    Updates <model_name>/LATEST. Returns the version string.
    """
    _assert_safe_component(model_name, "model_name")
    version = _assert_safe_component(version or _utc_version(), "version")
    model_root = os.path.join(registry_dir, model_name)
    version_dir = get_model_version_dir(
        registry_dir=registry_dir, model_name=model_name, version=version
    )
    _safe_mkdir(version_dir)

    model_path = os.path.join(version_dir, "model.joblib")
    config_path = os.path.join(version_dir, "feature_config.joblib")
    meta_path = os.path.join(version_dir, "metadata.json")

    joblib.dump(model, model_path)
    joblib.dump(feature_config, config_path)

    metadata = {
        "model_name": model_name,
        "version": version,
        "framework": "sklearn",
        "saved_at_utc": datetime.now(timezone.utc).isoformat(),
        "artifacts": {
            "model_path": model_path,
            "feature_config_path": config_path,
        },
        "feature_config": feature_config,
        "training": training_meta,
    }

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, sort_keys=True)

    set_latest(model_root, version)
    return version


def load_anomaly_bundle(
    *,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = ANOMALY_MODEL_NAME,
    version: Optional[str] = None,
) -> Tuple[Any, Dict[str, Any], Dict[str, Any]]:
    """
    Loads the anomaly model + feature_config + metadata.
    If version is None, resolves via LATEST. Raises FileNotFoundError when no
    version is registered.
    """
    _assert_safe_component(model_name, "model_name")
    model_root = os.path.join(registry_dir, model_name)
    resolved = version or get_latest(model_root)
    if not resolved:
        raise FileNotFoundError(f"No anomaly model version found for '{model_name}'")
    _assert_safe_component(resolved, "version")

    version_dir = get_model_version_dir(
        registry_dir=registry_dir, model_name=model_name, version=resolved
    )
    model_path = os.path.join(version_dir, "model.joblib")
    config_path = os.path.join(version_dir, "feature_config.joblib")
    meta_path = os.path.join(version_dir, "metadata.json")

    model = joblib.load(model_path)
    feature_config: Dict[str, Any] = {}
    try:
        feature_config = joblib.load(config_path) or {}
    except FileNotFoundError:
        feature_config = {}

    metadata: Dict[str, Any] = {}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)
    except FileNotFoundError:
        metadata = {"model_name": model_name, "version": resolved}

    return model, feature_config, metadata


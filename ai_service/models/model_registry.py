import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import joblib


DEFAULT_REGISTRY_DIR = os.getenv("ECOPULSE_MODEL_REGISTRY_DIR", "models/registry")
DEFAULT_MODEL_NAME = os.getenv("ECOPULSE_MODEL_NAME", "lstm_energy_forecast")


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
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
    version: Optional[str] = None,
) -> str:
    """
    Saves a versioned bundle:
      - model.keras
      - scaler.joblib
      - metadata.json
    Also updates <model_name>/LATEST.
    Returns the version string.
    """
    version = version or _utc_version()
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
    }

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, sort_keys=True)

    set_latest(model_root, version)
    return version


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
    model_root = os.path.join(registry_dir, model_name)
    resolved = version or get_latest(model_root)
    if not resolved:
        raise FileNotFoundError(f"No model version found for '{model_name}'")

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


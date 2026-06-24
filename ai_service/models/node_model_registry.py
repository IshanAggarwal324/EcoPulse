"""Per-node model store (Module 4.3.3).

Directory layout::

    <registry_dir>/<model_name>/nodes/<nodeId>/<version>/
        model.keras
        scaler.joblib
        metadata.json

Resolution at inference prefers a per-node artifact and **falls back to the
global model** when none exists for a node. This keeps forecasts available for
every node even before a per-node model is trained.

Security: ``node_id`` is untrusted (originates from API query params / DB). It
is validated to be a single path-safe segment before it is ever joined into a
filesystem path, preventing path traversal outside the registry root.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import joblib

from models.model_registry import (
    DEFAULT_MODEL_NAME,
    DEFAULT_REGISTRY_DIR,
    _assert_safe_component,
    _safe_mkdir,
    get_latest,
    set_latest,
)


# Per-node ids originate from MongoDB (ObjectId hex) but must be treated as
# untrusted user input. Allow alphanumerics, dash and underscore only, capped
# to a sane length. This rejects '..', '/', '\\', null bytes and unicode tricks.
_NODE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def assert_safe_node_id(node_id: str) -> str:
    """Validate an untrusted ``node_id`` before using it in a path."""
    if not isinstance(node_id, str) or not node_id:
        raise ValueError("node_id must be a non-empty string")
    if not _NODE_ID_RE.match(node_id):
        raise ValueError(
            "node_id must be 1-64 chars of [A-Za-z0-9_-] "
            "(no path separators, '..', or unicode)"
        )
    # Defence-in-depth: also reject anything that could escape a single segment.
    return _assert_safe_component(node_id, "node_id")


def _nodes_root(
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
) -> str:
    _assert_safe_component(model_name, "model_name")
    return os.path.join(registry_dir, model_name, "nodes")


def _node_root(
    node_id: str,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
) -> str:
    safe_node = assert_safe_node_id(node_id)
    return os.path.join(_nodes_root(registry_dir, model_name), safe_node)


def _utc_version() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def save_node_bundle(
    *,
    node_id: str,
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
    """Save a versioned per-node bundle and (optionally) promote it to LATEST."""
    safe_node = assert_safe_node_id(node_id)
    version = _assert_safe_component(version or _utc_version(), "version")

    node_root = _node_root(safe_node, registry_dir, model_name)
    version_dir = os.path.join(node_root, version)
    _safe_mkdir(version_dir)

    model_path = os.path.join(version_dir, "model.keras")
    scaler_path = os.path.join(version_dir, "scaler.joblib")
    meta_path = os.path.join(version_dir, "metadata.json")

    model.save(model_path)
    joblib.dump(scaler, scaler_path)

    metadata = {
        "model_name": model_name,
        "scope": "per_node",
        "node_id": safe_node,
        "version": version,
        "saved_at_utc": datetime.now(timezone.utc).isoformat(),
        "artifacts": {"model_path": model_path, "scaler_path": scaler_path},
        "preprocessing": preprocessing_meta,
        "training": training_meta,
        "metrics": metrics or {},
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, sort_keys=True)

    if promote:
        set_latest(node_root, version)
    return version


def get_latest_node_version(
    node_id: str,
    *,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
) -> Optional[str]:
    node_root = _node_root(node_id, registry_dir, model_name)
    return get_latest(node_root)


def list_node_versions(
    node_id: str,
    *,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
) -> list[Dict[str, Any]]:
    """Lightweight per-node version listing (metadata only, no model load)."""
    node_root = _node_root(node_id, registry_dir, model_name)
    if not os.path.isdir(node_root):
        return []
    summaries: list[Dict[str, Any]] = []
    latest = get_latest(node_root)
    for entry in os.listdir(node_root):
        entry_path = os.path.join(node_root, entry)
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
        summaries.append({
            "version": meta.get("version", entry),
            "saved_at_utc": meta.get("saved_at_utc"),
            "horizon": (meta.get("preprocessing", {}) or {}).get("horizon"),
            "n_rows": (meta.get("preprocessing", {}) or {}).get("n_rows"),
            "mape_generation": metrics.get("mape_generation"),
            "mape_consumption": metrics.get("mape_consumption"),
            "promoted": meta.get("version") == latest,
        })
    summaries.sort(key=lambda s: s.get("saved_at_utc") or "", reverse=True)
    return summaries


def load_node_bundle(
    *,
    node_id: str,
    registry_dir: str = DEFAULT_REGISTRY_DIR,
    model_name: str = DEFAULT_MODEL_NAME,
    version: Optional[str] = None,
    fallback_to_global: bool = True,
) -> Tuple[Any, Any, Dict[str, Any], str]:
    """Load a per-node bundle, falling back to the global model when missing.

    Returns ``(model, scaler, metadata, scope)`` where ``scope`` is
    ``"per_node"`` or ``"global"``. Raises ``FileNotFoundError`` only when no
    per-node artifact exists AND ``fallback_to_global`` is False (or the global
    model is also missing).
    """
    safe_node = assert_safe_node_id(node_id)
    node_root = _node_root(safe_node, registry_dir, model_name)
    resolved = version or get_latest(node_root)

    if resolved:
        # Lazy import keeps the module importable without TensorFlow.
        from tensorflow.keras.models import load_model  # type: ignore

        _assert_safe_component(resolved, "version")
        version_dir = os.path.join(node_root, resolved)
        model_path = os.path.join(version_dir, "model.keras")
        scaler_path = os.path.join(version_dir, "scaler.joblib")
        meta_path = os.path.join(version_dir, "metadata.json")
        model = load_model(model_path)
        scaler = joblib.load(scaler_path)
        metadata: Dict[str, Any] = {}
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                metadata = json.load(f)
        except FileNotFoundError:
            metadata = {"model_name": model_name, "scope": "per_node",
                        "node_id": safe_node, "version": resolved}
        metadata.setdefault("scope", "per_node")
        return model, scaler, metadata, "per_node"

    if not fallback_to_global:
        raise FileNotFoundError(
            f"No per-node model for node '{safe_node}' and global fallback disabled"
        )

    # Fall back to the global model (delegates to the trusted registry loader).
    from models.model_registry import load_bundle

    model, scaler, metadata = load_bundle(
        registry_dir=registry_dir, model_name=model_name, version=None
    )
    metadata.setdefault("scope", "global")
    return model, scaler, metadata, "global"

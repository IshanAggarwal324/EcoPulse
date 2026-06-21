"""In-memory forecast response cache (M9)."""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Optional

_CACHE: dict[str, tuple[float, Any]] = {}
_MAX_ENTRIES = 500


def _ttl_seconds() -> int:
    raw = os.environ.get("FORECAST_CACHE_TTL_SECONDS", "120")
    try:
        parsed = int(raw)
        return parsed if parsed > 0 else 120
    except ValueError:
        return 120


def _cache_key(prefix: str, payload: dict) -> str:
    raw = json.dumps(payload, sort_keys=True, default=str)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return f"{prefix}:{digest}"


def _prune() -> None:
    if len(_CACHE) <= _MAX_ENTRIES:
        return
    oldest = sorted(_CACHE.items(), key=lambda item: item[1][0])
    for key, _ in oldest[: len(_CACHE) - _MAX_ENTRIES]:
        _CACHE.pop(key, None)


def get_cached(prefix: str, payload: dict) -> Optional[Any]:
    key = _cache_key(prefix, payload)
    entry = _CACHE.get(key)
    if not entry:
        return None
    ts, value = entry
    if time.time() - ts >= _ttl_seconds():
        _CACHE.pop(key, None)
        return None
    return value


def set_cached(prefix: str, payload: dict, value: Any) -> None:
    key = _cache_key(prefix, payload)
    _CACHE[key] = (time.time(), value)
    _prune()

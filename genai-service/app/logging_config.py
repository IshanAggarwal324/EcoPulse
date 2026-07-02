"""genai-service logging bootstrap (Module 7.3).

Prefer the canonical shared implementation at ``shared/python/observability``;
fall back to an equivalent inline formatter when the shared package is not on
the path. Both paths emit the SAME JSON schema (parity asserted by tests).
"""
from __future__ import annotations

import json
import logging
import os
import sys
from contextvars import ContextVar
from datetime import datetime, timezone

SERVICE_NAME = "ecopulse-genai-service"
EXTRA_FIELDS = ("correlationId", "durationMs", "path", "status", "method", "traceId")
_CORRELATION_ID: ContextVar[str | None] = ContextVar("ecopulse_correlation_id", default=None)
_ACTIVE_SERVICE = SERVICE_NAME


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _shared_root() -> str | None:
    env_path = os.getenv("SHARED_PYTHON_PATH")
    if env_path and os.path.isdir(os.path.join(env_path, "observability")):
        return env_path
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        # dev: genai-service/app -> <repo>/shared/python
        os.path.normpath(os.path.join(here, "..", "..", "shared", "python")),
        "/app/shared/python",
    ]
    for candidate in candidates:
        if os.path.isdir(os.path.join(candidate, "observability")):
            return candidate
    return None


def _load_shared():
    root = _shared_root()
    if root and root not in sys.path:
        sys.path.insert(0, root)
    from observability import logging_config as shared  # noqa: WPS433

    return shared


class _CorrelationFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not getattr(record, "correlationId", None):
            cid = _CORRELATION_ID.get()
            if cid:
                record.correlationId = cid
        if not getattr(record, "service", None):
            record.service = _ACTIVE_SERVICE
        return True


class _InlineJsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": _now_iso(),
            "level": record.levelname.lower(),
            "service": getattr(record, "service", _ACTIVE_SERVICE),
            "msg": record.getMessage(),
        }
        for field in EXTRA_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value
        if record.exc_info:
            exc = record.exc_info[1]
            payload["err"] = {
                "name": type(exc).__name__ if exc is not None else "Error",
                "message": str(exc) if exc is not None else None,
            }
        return json.dumps(payload, separators=(",", ":"), default=str)


def _setup_inline(log_level: str) -> None:
    level = getattr(logging, log_level.upper(), logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_InlineJsonFormatter())
    handler.addFilter(_CorrelationFilter())
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
    root.addFilter(_CorrelationFilter())


def setup_logging(log_level: str | None = None) -> None:
    level = log_level or os.getenv("LOG_LEVEL", "INFO")
    try:
        shared = _load_shared()
    except Exception:  # pragma: no cover - shared not on path (Docker)
        shared = None

    if shared is not None:
        shared.setup_logging(
            service=SERVICE_NAME,
            log_level=level,
            log_format=os.getenv("LOG_FORMAT"),
        )
        return

    _setup_inline(level)

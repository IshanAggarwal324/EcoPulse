"""ai_service logging bootstrap (Module 7.3).

Prefer the canonical shared implementation at ``shared/python/observability``;
fall back to an equivalent inline formatter when the shared package is not on
the path (e.g. a service-scoped Docker image that did not vendor it). Both
paths emit the SAME JSON schema (parity is asserted by tests).
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Iterator
from uuid import uuid4

from app.config import Settings

SERVICE_NAME = "ecopulse-ai-service"
EXTRA_FIELDS = ("correlationId", "durationMs", "path", "status", "method", "traceId")
_CORRELATION_ID: ContextVar[str | None] = ContextVar("ecopulse_correlation_id", default=None)
_ACTIVE_SERVICE = SERVICE_NAME

# Populated by setup_logging() when the shared observability package is on the
# path. The correlation wrappers below bind BOTH this inline contextvar and the
# shared one so tracing works regardless of whether the shared or inline
# formatter/filter is active (parity asserted by tests).
_SHARED_MODULE: Any = None

# Module 7.4 — inbound x-request-id is untrusted (written to logs + echoed as a
# header). Same charset/length policy as the shared module, applied inline so
# the Docker fallback path is equally safe.
MAX_CORRELATION_ID_LENGTH = 128
_UNSAFE_CORRELATION_CHARS = re.compile(r"[^A-Za-z0-9_-]+")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _shared_root() -> str | None:
    """Resolve the repo ``shared/python`` dir from known locations."""
    env_path = os.getenv("SHARED_PYTHON_PATH")
    if env_path and os.path.isdir(os.path.join(env_path, "observability")):
        return env_path
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        # dev: ai_service/app -> <repo>/shared/python
        os.path.normpath(os.path.join(here, "..", "..", "shared", "python")),
        # Docker convention
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
    # noqa: imported lazily after sys.path tweak
    from observability import logging_config as shared  # noqa: WPS433

    return shared


def _sanitize_inline(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = _UNSAFE_CORRELATION_CHARS.sub("", str(value))
    if not cleaned or len(cleaned) > MAX_CORRELATION_ID_LENGTH:
        return None
    return cleaned


def sanitize_correlation_id(value: Any) -> str | None:
    """Delegate to the shared sanitizer when loaded, else use the inline one."""
    if _SHARED_MODULE is not None:
        return _SHARED_MODULE.sanitize_correlation_id(value)
    return _sanitize_inline(value)


def resolve_request_correlation_id(header_value: Any) -> str:
    """Sanitize an inbound ``x-request-id`` or generate a fresh UUID."""
    return sanitize_correlation_id(header_value) or uuid4().hex


def bind_correlation_id(value: str | None) -> None:
    """Bind the correlation id for the current async context (Module 7.4).

    Binds BOTH the inline contextvar and the shared one so the id appears in
    logs under either the shared or the inline formatter/filter path.
    """
    safe = _sanitize_inline(value)
    _CORRELATION_ID.set(safe)
    if _SHARED_MODULE is not None:
        _SHARED_MODULE.bind_correlation_id(safe)


def reset_correlation_id() -> None:
    _CORRELATION_ID.set(None)
    if _SHARED_MODULE is not None:
        _SHARED_MODULE.reset_correlation_id()


def get_correlation_id() -> str | None:
    if _SHARED_MODULE is not None:
        return _SHARED_MODULE.get_correlation_id()
    return _CORRELATION_ID.get()


@contextmanager
def correlation_context(correlation_id: str | None) -> Iterator[None]:
    """Bind a correlation id for the duration of the ``with`` block."""
    safe = _sanitize_inline(correlation_id)
    token_inline = _CORRELATION_ID.set(safe)
    shared_cm = (
        _SHARED_MODULE.correlation_context(safe)
        if _SHARED_MODULE is not None
        else nullcontext()
    )
    with shared_cm:
        try:
            yield
        finally:
            _CORRELATION_ID.reset(token_inline)


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
    """Fallback formatter — behaviorally identical to the shared JsonFormatter."""

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


def _setup_inline(settings: Settings) -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_InlineJsonFormatter())
    handler.addFilter(_CorrelationFilter())
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
    root.addFilter(_CorrelationFilter())


def setup_logging(settings: Settings) -> None:
    global _SHARED_MODULE
    try:
        shared = _load_shared()
    except Exception:  # pragma: no cover - shared not on path (Docker)
        shared = None
    _SHARED_MODULE = shared

    if shared is not None:
        shared.setup_logging(
            service=SERVICE_NAME,
            log_level=os.getenv("LOG_LEVEL", settings.log_level),
            log_format=os.getenv("LOG_FORMAT"),
            log_file=settings.log_file or None,
        )
        return

    _setup_inline(settings)

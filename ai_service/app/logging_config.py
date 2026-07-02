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
_TRACEPARENT: ContextVar[str | None] = ContextVar("ecopulse_traceparent", default=None)
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


# Module 7.6 — W3C Trace Context ``traceparent`` propagation.
#
# ``traceparent`` is untrusted inbound: it is written into structured logs (the
# trace id) and echoed/forwarded as an HTTP header. An invalid or malformed
# value must NEVER be trusted verbatim — a smuggled newline enables log forging
# and a CR/LF enables header injection. Only values matching the exact W3C
# grammar survive; everything else is replaced with a freshly generated trace
# context.
#
# Format: version(2)-trace_id(32)-parent_id(16)-trace_flags(2), lowercase hex.
_TRACEPARENT_RE = re.compile(r"^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$")


def sanitize_traceparent(value: Any) -> str | None:
    """Return a valid W3C traceparent, or ``None`` when invalid/malformed."""
    if value is None:
        return None
    candidate = str(value).strip().lower()
    if not _TRACEPARENT_RE.match(candidate):
        return None
    parts = candidate.split("-")
    version, trace_id, parent_id, flags = parts
    # 0xff is a forbidden version; trace/parent ids must not be all zeros.
    if version == "ff":
        return None
    if trace_id == "0" * 32 or parent_id == "0" * 16:
        return None
    return candidate


def _generate_traceparent() -> str:
    """Create a fresh, valid traceparent (version 00, sampled flag 01)."""
    trace_id = uuid4().hex  # 32 hex chars
    parent_id = uuid4().hex[:16]  # 16 hex chars
    return f"00-{trace_id}-{parent_id}-01"


def resolve_traceparent(header_value: Any) -> str:
    """Validate an inbound ``traceparent`` or mint a fresh trace context."""
    return sanitize_traceparent(header_value) or _generate_traceparent()


def bind_traceparent(value: str | None) -> None:
    safe = sanitize_traceparent(value)
    _TRACEPARENT.set(safe)
    if _SHARED_MODULE is not None and hasattr(_SHARED_MODULE, "bind_traceparent"):
        _SHARED_MODULE.bind_traceparent(safe)


def get_traceparent() -> str | None:
    return _TRACEPARENT.get()


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
def correlation_context(
    correlation_id: str | None, traceparent: str | None = None
) -> Iterator[None]:
    """Bind a correlation id (and optional traceparent) for the block."""
    safe = _sanitize_inline(correlation_id)
    safe_tp = sanitize_traceparent(traceparent)
    token_inline = _CORRELATION_ID.set(safe)
    token_tp = _TRACEPARENT.set(safe_tp)
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
            _TRACEPARENT.reset(token_tp)


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

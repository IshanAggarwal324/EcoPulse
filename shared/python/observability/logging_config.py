"""EcoPulse shared structured logging (Module 7.3) — canonical implementation.

Emits one JSON object per line to stdout (optional file) for log aggregation,
mirroring the backend's JSON schema so logs correlate across the stack:

    {"ts":"...","level":"info","service":"ecopulse-ai-service",
     "correlationId":"...","msg":"...","durationMs":12,"path":"/forecast","status":200}

Config (env): ``LOG_LEVEL`` (default INFO), ``LOG_FORMAT=json|text`` (default
json). ``setup_logging()`` is idempotent-ish (uses ``force=True``).

Correlation: a contextvar holds the request id; ``bind_correlation_id`` /
``correlation_context`` populate it (Module 7.4 wires ``x-request-id`` into
this). Until then the field is simply absent.

SECURITY: this module never emits secrets on its own — it formats the message
and a fixed whitelist of request fields. Callers must not interpolate
secrets/URLs into log messages. Access logs use ``request.url.path`` (no query
string) so request parameters are never logged.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Iterator
from uuid import uuid4

__all__ = [
    "SERVICE_DEFAULT",
    "EXTRA_FIELDS",
    "MAX_CORRELATION_ID_LENGTH",
    "JsonFormatter",
    "TextFormatter",
    "setup_logging",
    "get_correlation_id",
    "bind_correlation_id",
    "reset_correlation_id",
    "correlation_context",
    "sanitize_correlation_id",
    "resolve_request_correlation_id",
    "log_access",
    "now_iso",
]

SERVICE_DEFAULT = "ecopulse-python"

# Whitelist of request/context fields surfaced on every applicable record.
# Kept explicit (not **record.__dict__) so secrets never accidentally leak via
# stray log extras.
EXTRA_FIELDS = ("correlationId", "durationMs", "path", "status", "method", "traceId")

_CORRELATION_ID: ContextVar[str | None] = ContextVar("ecopulse_correlation_id", default=None)
_TRACEPARENT: ContextVar[str | None] = ContextVar("ecopulse_traceparent", default=None)

_ACTIVE_SERVICE = SERVICE_DEFAULT

# Module 7.4 — safe charset + length bound for the correlation id. The inbound
# `x-request-id` is untrusted: it is written into JSON logs and echoed as a
# header, so an embedded newline enables log forging and a CR/LF enables header
# injection. Only this charset survives sanitization, and the length is bounded
# to prevent log bloat / DoS via an oversized id.
MAX_CORRELATION_ID_LENGTH = 128
_UNSAFE_CORRELATION_CHARS = re.compile(r"[^A-Za-z0-9_-]+")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_correlation_id(value: Any) -> str | None:
    """Reduce an untrusted value to a safe correlation id, or ``None``.

    Strips every character outside ``[A-Za-z0-9_-]`` and rejects empty /
    over-length results. ``None``/empty input yields ``None`` so callers fall
    back to a generated id rather than trusting a malformed one.
    """
    if value is None:
        return None
    cleaned = _UNSAFE_CORRELATION_CHARS.sub("", str(value))
    if not cleaned or len(cleaned) > MAX_CORRELATION_ID_LENGTH:
        return None
    return cleaned


def resolve_request_correlation_id(header_value: Any) -> str:
    """Return a safe correlation id for an inbound request.

    Sanitizes the supplied ``x-request-id``; when it is absent or fails
    validation a fresh UUID is generated. Never returns an empty/untrusted id.
    """
    return sanitize_correlation_id(header_value) or uuid4().hex


# Module 7.6 — W3C Trace Context ``traceparent`` propagation.
#
# ``traceparent`` is untrusted inbound: it is written into structured logs (the
# trace id) and echoed/forwarded as an HTTP header. An invalid/malformed value
# must NEVER be trusted verbatim (newline -> log forging; CR/LF -> header
# injection). Only values matching the exact W3C grammar survive; everything
# else is replaced with a freshly generated trace context.
_TRACEPARENT_RE = re.compile(r"^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$")


def sanitize_traceparent(value: Any) -> str | None:
    """Return a valid W3C traceparent, or ``None`` when invalid/malformed."""
    if value is None:
        return None
    candidate = str(value).strip().lower()
    if not _TRACEPARENT_RE.match(candidate):
        return None
    version, trace_id, parent_id, _flags = candidate.split("-")
    if version == "ff":
        return None
    if trace_id == "0" * 32 or parent_id == "0" * 16:
        return None
    return candidate


def _generate_traceparent() -> str:
    """Create a fresh, valid traceparent (version 00, sampled flag 01)."""
    return f"00-{uuid4().hex}-{uuid4().hex[:16]}-01"


def resolve_traceparent(header_value: Any) -> str:
    """Validate an inbound ``traceparent`` or mint a fresh trace context."""
    return sanitize_traceparent(header_value) or _generate_traceparent()


def bind_traceparent(value: str | None) -> None:
    _TRACEPARENT.set(sanitize_traceparent(value))


def get_traceparent() -> str | None:
    return _TRACEPARENT.get()


def _resolve_level(value: Any) -> int:
    if isinstance(value, int):
        return value
    name = str(value or "INFO").upper()
    return getattr(logging, name, logging.INFO) if name in logging._nameToLevel else logging.INFO


def _resolve_format(value: Any) -> str:
    fmt = str(value or os.getenv("LOG_FORMAT", "json")).strip().lower()
    return fmt if fmt in ("json", "text") else "json"


def get_correlation_id() -> str | None:
    return _CORRELATION_ID.get()


def bind_correlation_id(value: str | None) -> None:
    """Set the correlation id for the current async context (Module 7.4).

    The value is always sanitized so a malformed upstream id can never reach
    log lines even if a caller forgets to resolve it first.
    """
    _CORRELATION_ID.set(sanitize_correlation_id(value))


def reset_correlation_id() -> None:
    _CORRELATION_ID.set(None)


@contextmanager
def correlation_context(correlation_id: str | None) -> Iterator[None]:
    token = _CORRELATION_ID.set(sanitize_correlation_id(correlation_id))
    try:
        yield
    finally:
        _CORRELATION_ID.reset(token)


class _CorrelationFilter(logging.Filter):
    """Stamp every record with the active correlation id + service name."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not getattr(record, "correlationId", None):
            cid = _CORRELATION_ID.get()
            if cid:
                record.correlationId = cid
        if not getattr(record, "service", None):
            record.service = _ACTIVE_SERVICE
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": now_iso(),
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


class TextFormatter(logging.Formatter):
    """Human-readable fallback for local development (LOG_FORMAT=text)."""

    def format(self, record: logging.LogRecord) -> str:
        cid = getattr(record, "correlationId", None) or _CORRELATION_ID.get()
        suffix = f" cid={cid}" if cid else ""
        extras = " ".join(
            f"{f}={getattr(record, f)}" for f in EXTRA_FIELDS if getattr(record, f, None) is not None
        )
        base = f"{self.formatTime(record, '%Y-%m-%dT%H:%M:%S')} {record.levelname} {record.getMessage()}"
        return f"{base} [{getattr(record, 'service', _ACTIVE_SERVICE)}]{suffix} {extras}".rstrip()


def _build_handlers(log_file: str | None, formatter: logging.Formatter) -> list[logging.Handler]:
    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(formatter)
    stdout_handler.addFilter(_CorrelationFilter())
    handlers: list[logging.Handler] = [stdout_handler]

    if log_file:
        try:
            from pathlib import Path

            path = Path(log_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = logging.FileHandler(path)
            file_handler.setFormatter(formatter)
            file_handler.addFilter(_CorrelationFilter())
            handlers.append(file_handler)
        except OSError:
            # File logging is best-effort; never fail boot over it.
            logging.getLogger(__name__).warning("Could not open log file %s", log_file)

    return handlers


def setup_logging(
    service: str = SERVICE_DEFAULT,
    log_level: Any = None,
    log_format: Any = None,
    log_file: str | None = None,
) -> None:
    """Configure the root logger with the shared JSON (or text) formatter."""
    global _ACTIVE_SERVICE
    _ACTIVE_SERVICE = service or SERVICE_DEFAULT

    level = _resolve_level(log_level or os.getenv("LOG_LEVEL", "INFO"))
    fmt = _resolve_format(log_format)
    formatter = JsonFormatter() if fmt == "json" else TextFormatter()

    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    for handler in _build_handlers(log_file, formatter):
        root.addHandler(handler)
    root.setLevel(level)
    root.addFilter(_CorrelationFilter())


def log_access(
    logger: logging.Logger,
    method: str,
    path: str,
    status: int,
    duration_ms: float,
    **extra: Any,
) -> None:
    """Emit a structured HTTP access-log line (used by request middleware)."""
    logger.info(
        "%s %s -> %s",
        method,
        path,
        status,
        extra={
            "method": method,
            "path": path,
            "status": status,
            "durationMs": round(float(duration_ms), 2),
            **{k: v for k, v in extra.items() if k in EXTRA_FIELDS},
        },
    )

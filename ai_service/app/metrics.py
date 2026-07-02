"""Prometheus metrics for ai_service (Module 7.5).

Dependency-free Prometheus text exposition (mirrors the backend's
``backend/services/metrics/prometheus.js``) so no third-party package is
required and the ``ecopulse_*`` metric namespace is consistent across the stack.

Metric families (namespaced to avoid collisions):
  - ecopulse_http_requests_total          (counter)  per method/path/status
  - ecopulse_http_request_duration_seconds (histogram) per method/path
  - ecopulse_model_ready                  (gauge)    1 when LSTM artifacts loaded
  - ecopulse_inference_total              (counter)  model inference calls
  - ecopulse_process_uptime_seconds       (gauge)    process uptime

SECURITY: ``/metrics`` is exempt from the internal API-key gate (so a scraper
holding METRICS_TOKEN can reach it) but is itself protected by METRICS_TOKEN.
In production the endpoint is DISABLED (404) when no token is configured —
operational metrics are never exposed openly. HTTP path labels are normalized
to route templates to bound label cardinality (prevents memory-exhaustion via
high-cardinality labels like ``/nodes/<opaque-id>``).
"""
from __future__ import annotations

import hmac
import os
import time
from typing import Any, Mapping

SERVICE_NAME = "ecopulse-ai-service"
SERVICE_LABEL = "ai_service"

_START_TIME = time.time()

# SLO-oriented latency buckets (seconds).
HTTP_DURATION_BUCKETS = (
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
)

# name -> (type, help, buckets|None)
_METRIC_DEFS: dict[str, tuple[str, str, tuple[float, ...] | None]] = {
    "ecopulse_http_requests_total": ("counter", "Total HTTP requests handled", None),
    "ecopulse_http_request_duration_seconds": (
        "histogram",
        "HTTP request duration in seconds",
        HTTP_DURATION_BUCKETS,
    ),
    "ecopulse_model_ready": (
        "gauge",
        "1 if the forecast model artifacts are loaded, else 0",
        None,
    ),
    "ecopulse_inference_total": ("counter", "Model inference calls served", None),
    "ecopulse_process_uptime_seconds": ("gauge", "Process uptime in seconds", None),
}

_counters: dict[str, float] = {}
_gauges: dict[str, float] = {}
_hists: dict[str, dict[str, Any]] = {}

# Bound path-label length so a pathological route never bloats the exposition.
_MAX_PATH_LABEL = 100


def reset() -> None:
    """Clear all recorded metrics (test helper / state isolation)."""
    _counters.clear()
    _gauges.clear()
    _hists.clear()


def _escape(value: Any) -> str:
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
    )


def _signature(labels: Mapping[str, Any] | None) -> tuple[tuple[str, str], ...]:
    if not labels:
        return ()
    return tuple(sorted((str(k), _escape(v)) for k, v in labels.items()))


def _render_labels(sig: tuple[tuple[str, str], ...], extra: tuple[tuple[str, str], ...] = ()) -> str:
    parts = list(sig) + [(k, _escape(v)) for k, v in extra]
    return "{" + ",".join(f'{k}="{v}"' for k, v in parts) + "}" if parts else ""


def _base_name(key: str) -> str:
    return key.split("{", 1)[0]


def _check(name: str, expected: str) -> None:
    if name not in _METRIC_DEFS:
        raise KeyError(f"Unknown metric: {name}")
    if _METRIC_DEFS[name][0] != expected:
        raise TypeError(f"Metric {name} is {_METRIC_DEFS[name][0]}, not {expected}")


def inc(name: str, labels: Mapping[str, Any] | None = None, value: float = 1.0) -> None:
    _check(name, "counter")
    if value < 0:
        raise ValueError("counter increment must be non-negative")
    sig = _signature(labels)
    key = name + _render_labels(sig)
    _counters[key] = _counters.get(key, 0.0) + float(value)


def gauge(name: str, value: float, labels: Mapping[str, Any] | None = None) -> None:
    _check(name, "gauge")
    sig = _signature(labels)
    key = name + _render_labels(sig)
    _gauges[key] = float(value)


def observe(name: str, value: float, labels: Mapping[str, Any] | None = None) -> None:
    _check(name, "histogram")
    value = max(0.0, float(value))
    buckets = _METRIC_DEFS[name][2] or ()
    sig = _signature(labels)
    key = name + _render_labels(sig)
    entry = _hists.get(key)
    if entry is None:
        entry = {
            "labels": sig,
            "buckets": [0] * (len(buckets) + 1),  # last slot is +Inf
            "count": 0,
            "sum": 0.0,
        }
        _hists[key] = entry
    for i, boundary in enumerate(buckets):
        if value <= boundary:
            entry["buckets"][i] += 1
    entry["buckets"][-1] += 1
    entry["count"] += 1
    entry["sum"] += value


def _normalize_path_label(path: str) -> str:
    p = path or "/"
    return p[:_MAX_PATH_LABEL] if len(p) > _MAX_PATH_LABEL else p


def normalize_route(request: Any) -> str:
    """Resolve a low-cardinality route label for the current request.

    Prefers the matched route template (e.g. ``/forecast/``) over the raw path
    so opaque path parameters never become label values. Unmatched requests
    collapse to ``unmatched`` to bound cardinality.
    """
    scope = getattr(request, "scope", None) or {}
    route = scope.get("route")
    path = getattr(route, "path", None)
    if path:
        return _normalize_path_label(path)
    raw = getattr(getattr(request, "url", None), "path", None)
    if raw and raw in ("/",):
        return "/"
    return "unmatched"


def record_http_request(
    method: str, path_template: str, status: int, duration_seconds: float
) -> None:
    labels = {
        "method": (method or "UNKNOWN").upper(),
        "path": _normalize_path_label(path_template),
        "status": str(int(status)) if status is not None else "0",
    }
    inc("ecopulse_http_requests_total", labels)
    observe(
        "ecopulse_http_request_duration_seconds",
        duration_seconds,
        {"method": labels["method"], "path": labels["path"]},
    )


def record_inference(kind: str = "forecast") -> None:
    inc("ecopulse_inference_total", {"kind": str(kind) or "unknown"})


def _format_num(value: float) -> str:
    f = float(value)
    return str(int(f)) if f.is_integer() else repr(f)


def _format_bucket(value: float) -> str:
    return _format_num(value)


def render() -> str:
    # Refresh process-derived gauges on every scrape so they are always fresh.
    gauge("ecopulse_process_uptime_seconds", time.time() - _START_TIME)

    lines: list[str] = [
        "# HELP ecopulse_info EcoPulse service identity",
        "# TYPE ecopulse_info gauge",
        f'ecopulse_info{{service="{_escape(SERVICE_NAME)}"}} 1',
    ]

    for name, (mtype, help_text, _buckets) in _METRIC_DEFS.items():
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} {mtype}")

        if mtype == "counter":
            for key, value in sorted(_counters.items()):
                if _base_name(key) == name:
                    lines.append(f"{key} {_format_num(value)}")
        elif mtype == "gauge":
            for key, value in sorted(_gauges.items()):
                if _base_name(key) == name:
                    lines.append(f"{key} {_format_num(value)}")
        elif mtype == "histogram":
            boundaries = _buckets or ()
            for key, entry in sorted(_hists.items()):
                if _base_name(key) != name:
                    continue
                sig = entry["labels"]
                for i, boundary in enumerate(boundaries):
                    lines.append(
                        f"{name}{_render_labels(sig, [('le', _format_bucket(boundary))])} "
                        f"{entry['buckets'][i]}"
                    )
                lines.append(
                    f"{name}{_render_labels(sig, [('le', '+Inf')])} {entry['buckets'][-1]}"
                )
                lines.append(
                    f"{name}_count{_render_labels(sig)} {entry['count']}"
                )
                lines.append(
                    f"{name}_sum{_render_labels(sig)} {_format_num(entry['sum'])}"
                )

    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# /metrics authorization
# --------------------------------------------------------------------------- #

def _is_production() -> bool:
    return os.getenv("NODE_ENV") == "production"


def _metrics_token() -> str:
    return str(os.getenv("METRICS_TOKEN", "")).strip()


def metrics_enabled() -> bool:
    if str(os.getenv("METRICS_ENABLED", "true")).lower() == "false":
        return False
    # Production guard rail: never expose operational metrics without a token.
    if _is_production() and not _metrics_token():
        return False
    return True


def is_authorized(authorization: str | None, metrics_token_header: str | None) -> bool:
    """Validate a scrape credential using a constant-time comparison."""
    token = _metrics_token()
    # No token configured -> only reachable outside production (gated above).
    if not token:
        return True

    provided = None
    if authorization and authorization.startswith("Bearer "):
        provided = authorization[len("Bearer "):].strip()
    elif metrics_token_header:
        provided = str(metrics_token_header).strip()

    if not provided:
        return False
    # hmac.compare_digest is constant-time for equal-length ascii strings.
    return hmac.compare_digest(provided, token)

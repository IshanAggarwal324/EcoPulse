# EcoPulse Observability — Metrics (Module 7.5)

All three application tiers expose a Prometheus scrape endpoint at `GET /metrics`
using a consistent `ecopulse_*` metric namespace. No third-party dependency is
required — the exposition is dependency-free (stdlib only) so the format is
identical across Node and Python.

## Scrape targets

| Service     | Endpoint                | Default port |
|-------------|-------------------------|--------------|
| backend     | `GET /metrics`          | 5000         |
| ai_service  | `GET /metrics`          | 8000         |
| genai-service | `GET /metrics`        | 8001         |

## Security model

`/metrics` is exempt from the internal `INTERNAL_SERVICE_API_KEY` gate (so a
scraper does not need the shared internal key) but is protected by a dedicated
`METRICS_TOKEN`:

- `METRICS_TOKEN` unset + `NODE_ENV=production` → endpoint is **disabled (404)**.
  Operational metrics are never exposed unauthenticated in production.
- `METRICS_TOKEN` set → authenticate with either `Authorization: Bearer <token>`
  or `x-metrics-token: <token>`. Token comparison is constant-time.
- Dev (`NODE_ENV != production`) → open when no token is set, for convenience.

Set `METRICS_ENABLED=false` to disable on any service regardless of environment.

## Metric families

### backend (`backend/services/metrics/prometheus.js`)
- `ecopulse_http_requests_total` (counter) — `method`, `route`, `status`
- `ecopulse_http_request_duration_ms` (histogram: `_count`, `_sum`) — `method`, `route`
- `ecopulse_dependency_health` (gauge) — `service` (1=healthy, 0.5=degraded, 0=down)
- `ecopulse_ingestion_*` (gauge) — telemetry counters
- `ecopulse_process_uptime_seconds`, `ecopulse_nodejs_heap_used_bytes` (gauge)

### ai_service (`ai_service/app/metrics.py`)
- `ecopulse_http_requests_total` (counter) — `method`, `path`, `status`
- `ecopulse_http_request_duration_seconds` (histogram w/ buckets) — `method`, `path`
- `ecopulse_model_ready` (gauge) — 1 when LSTM artifacts loaded
- `ecopulse_inference_total` (counter) — `kind` (`forecast` | `anomaly`)
- `ecopulse_process_uptime_seconds` (gauge)

### genai-service (`genai-service/app/metrics.py`)
- `ecopulse_http_requests_total` (counter) — `method`, `path`, `status`
- `ecopulse_http_request_duration_seconds` (histogram w/ buckets) — `method`, `path`
- `ecopulse_genai_available` (gauge) — 1 when Gemini configured/enabled
- `ecopulse_doc_chunks_loaded` (gauge) — distinct source docs indexed
- `ecopulse_process_uptime_seconds` (gauge)

## Cardinality control

HTTP path labels use the matched **route template** (e.g. `/forecast/`), never
the raw URL, so opaque path parameters (node ids, wallet addresses) cannot
explode label cardinality and exhaust memory. Unmatched requests collapse to
`unmatched`.

## Example Prometheus config

See `prometheus.yml` in this directory. Uncomment the `prometheus` service in
`docker-compose.yml` to run it locally, then browse http://localhost:9090.

```yaml
scrape_configs:
  - job_name: ecopulse-backend
    metrics_path: /metrics
    scheme: http
    bearer_token: ${METRICS_TOKEN}        # set via Prometheus env
    static_configs:
      - targets: ['backend:5000']
  - job_name: ecopulse-ai-service
    metrics_path: /metrics
    bearer_token: ${METRICS_TOKEN}
    static_configs:
      - targets: ['ai-service:8000']
  - job_name: ecopulse-genai-service
    metrics_path: /metrics
    bearer_token: ${METRICS_TOKEN}
    static_configs:
      - targets: ['genai-service:8001']
```

## Suggested alerts

- `ecopulse_dependency_health{service="mongodb"} == 0` → backend is down (critical).
- `ecopulse_model_ready == 0` (ai_service) → serving heuristic fallback.
- `ecopulse_genai_available == 0` (genai-service) → chat runs in fallback mode.
- `rate(ecopulse_inference_total[5m])` → forecast/anomaly throughput.
- `histogram_quantile(0.95, rate(ecopulse_http_request_duration_seconds_bucket[5m]))` → p95 latency.

## Tracing (Module 7.6)

All services propagate the W3C `traceparent` header (validated against the
exact grammar; invalid values are replaced with a fresh trace context) alongside
`x-request-id` for end-to-end correlation. Full OpenTelemetry is a P2 roadmap
item — see `docs/EcoPulse_Deployment_Readiness.md`.

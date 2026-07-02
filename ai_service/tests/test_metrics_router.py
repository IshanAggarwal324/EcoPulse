"""Tests for ai_service Prometheus metrics (Module 7.5).

Covers the dependency-free metrics engine (app.metrics) and the /metrics route
handler. No httpx/TestClient is required: the engine is exercised directly and
the handler is invoked with a lightweight fake request, so the suite runs
wherever the stdlib + fastapi do.
"""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import metrics  # noqa: E402
from app.routers.metrics import get_metrics  # noqa: E402


class _Env:
    def __init__(self, **overrides):
        self.overrides = overrides
        self.backup = {}

    def __enter__(self):
        for k, v in self.overrides.items():
            self.backup[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self.backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class _FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class _FakeRequest:
    def __init__(self, headers=None, route_path=None):
        route = types.SimpleNamespace(path=route_path) if route_path else None
        self.scope = {"route": route} if route else {}
        self.headers = _FakeHeaders(headers or {})
        self.url = types.SimpleNamespace(path="/forecast/")


class EngineTests(unittest.TestCase):
    def setUp(self):
        metrics.reset()

    def test_info_and_uptime_are_present(self):
        body = metrics.render()
        self.assertIn('ecopulse_info{service="ecopulse-ai-service"} 1', body)
        self.assertIn("# TYPE ecopulse_process_uptime_seconds gauge", body)
        self.assertIn("ecopulse_process_uptime_seconds ", body)

    def test_record_http_request_emits_counter_and_histogram(self):
        metrics.record_http_request("GET", "/forecast/", 200, 0.02)
        body = metrics.render()
        self.assertIn(
            'ecopulse_http_requests_total{method="GET",path="/forecast/",status="200"} 1',
            body,
        )
        self.assertIn("# TYPE ecopulse_http_request_duration_seconds histogram", body)
        self.assertIn('le="+Inf"} 1', body)
        self.assertIn(
            'ecopulse_http_request_duration_seconds_count{method="GET",path="/forecast/"} 1',
            body,
        )

    def test_histogram_buckets_are_cumulative(self):
        for _ in range(3):
            metrics.observe("ecopulse_http_request_duration_seconds", 0.003, {"method": "GET", "path": "/x"})
        body = metrics.render()
        # 0.003 <= 0.005 -> the smallest bucket, and +Inf, all hold 3.
        self.assertIn('path="/x",le="0.005"} 3', body)
        self.assertIn('path="/x",le="+Inf"} 3', body)

    def test_inference_counter_is_namespaced(self):
        metrics.record_inference("forecast")
        metrics.record_inference("anomaly")
        body = metrics.render()
        self.assertIn('ecopulse_inference_total{kind="forecast"} 1', body)
        self.assertIn('ecopulse_inference_total{kind="anomaly"} 1', body)

    def test_gauge_is_settable(self):
        metrics.gauge("ecopulse_model_ready", 1)
        self.assertIn("ecopulse_model_ready 1", metrics.render())
        metrics.gauge("ecopulse_model_ready", 0)
        self.assertIn("ecopulse_model_ready 0", metrics.render())

    def test_unknown_metric_is_rejected(self):
        with self.assertRaises(KeyError):
            metrics.inc("does_not_exist")
        with self.assertRaises(TypeError):
            metrics.inc("ecopulse_model_ready")  # gauge, not counter

    def test_normalize_route_prefers_template(self):
        self.assertEqual(metrics.normalize_route(_FakeRequest(route_path="/forecast/")), "/forecast/")
        self.assertEqual(metrics.normalize_route(_FakeRequest(route_path=None)), "unmatched")

    def test_label_values_are_escaped(self):
        # A path containing a quote/backslash must not break the exposition.
        metrics.record_http_request("GET", '/x"y', 200, 0.01)
        body = metrics.render()
        self.assertIn('path="/x\\"y"', body)


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        metrics.reset()

    def test_disabled_when_metrics_enabled_false(self):
        with _Env(METRICS_ENABLED="false", NODE_ENV="development", METRICS_TOKEN=""):
            self.assertFalse(metrics.metrics_enabled())

    def test_open_in_dev_without_token(self):
        with _Env(METRICS_ENABLED="true", NODE_ENV="development", METRICS_TOKEN=""):
            self.assertTrue(metrics.metrics_enabled())
            self.assertTrue(metrics.is_authorized(None, None))

    def test_disabled_in_production_without_token(self):
        with _Env(METRICS_ENABLED="true", NODE_ENV="production", METRICS_TOKEN=""):
            self.assertFalse(metrics.metrics_enabled())

    def test_token_required_and_checked_constant_time(self):
        with _Env(NODE_ENV="production", METRICS_TOKEN="scraper-secret"):
            self.assertFalse(metrics.is_authorized(None, None))
            self.assertFalse(metrics.is_authorized("Bearer nope", None))
            self.assertTrue(metrics.is_authorized("Bearer scraper-secret", None))
            self.assertTrue(metrics.is_authorized(None, "scraper-secret"))
            self.assertFalse(metrics.is_authorized(None, "wrong"))


class RouteHandlerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        metrics.reset()

    async def test_returns_exposition_when_open(self):
        with _Env(NODE_ENV="development", METRICS_TOKEN="", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest())
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"ecopulse_info", resp.body)

    async def test_disabled_in_production_without_token(self):
        with _Env(NODE_ENV="production", METRICS_TOKEN="", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest())
        self.assertEqual(resp.status_code, 404)

    async def test_unauthorized_without_token_when_protected(self):
        with _Env(NODE_ENV="production", METRICS_TOKEN="secret", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest())
        self.assertEqual(resp.status_code, 401)

    async def test_authorized_with_bearer_token(self):
        with _Env(NODE_ENV="production", METRICS_TOKEN="secret", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest({"authorization": "Bearer secret"}))
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"ecopulse_model_ready", resp.body)


if __name__ == "__main__":
    unittest.main()

"""Tests for genai-service Prometheus metrics (Module 7.5).

Covers the dependency-free metrics engine (app.metrics) and the /metrics route
handler. No httpx/TestClient is required: the engine is exercised directly and
the handler is invoked with a lightweight fake request.
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


class _FakeRag:
    def __init__(self, count):
        self.docs_loaded_count = count


class _FakeRequest:
    def __init__(self, headers=None, rag=None):
        self.headers = _FakeHeaders(headers or {})
        state = types.SimpleNamespace(doc_rag_service=rag)
        self.app = types.SimpleNamespace(state=state)
        self.url = types.SimpleNamespace(path="/assistant/chat")


class EngineTests(unittest.TestCase):
    def setUp(self):
        metrics.reset()

    def test_info_and_uptime_are_present(self):
        body = metrics.render()
        self.assertIn('ecopulse_info{service="ecopulse-genai-service"} 1', body)
        self.assertIn("# TYPE ecopulse_process_uptime_seconds gauge", body)

    def test_record_http_request_emits_counter_and_histogram(self):
        metrics.record_http_request("POST", "/assistant/chat", 200, 0.04)
        body = metrics.render()
        self.assertIn(
            'ecopulse_http_requests_total{method="POST",path="/assistant/chat",status="200"} 1',
            body,
        )
        self.assertIn('le="+Inf"} 1', body)
        self.assertIn(
            'ecopulse_http_request_duration_seconds_count{method="POST",path="/assistant/chat"} 1',
            body,
        )

    def test_genai_specific_gauges_are_settable(self):
        metrics.gauge("ecopulse_genai_available", 1)
        metrics.gauge("ecopulse_doc_chunks_loaded", 42)
        body = metrics.render()
        self.assertIn("ecopulse_genai_available 1", body)
        self.assertIn("ecopulse_doc_chunks_loaded 42", body)

    def test_unknown_metric_is_rejected(self):
        with self.assertRaises(KeyError):
            metrics.inc("does_not_exist")
        with self.assertRaises(TypeError):
            metrics.gauge("ecopulse_http_requests_total", 1)

    def test_normalize_route_prefers_template(self):
        req = types.SimpleNamespace(
            scope={"route": types.SimpleNamespace(path="/assistant/chat")},
            url=types.SimpleNamespace(path="/assistant/chat"),
        )
        self.assertEqual(metrics.normalize_route(req), "/assistant/chat")
        req2 = types.SimpleNamespace(scope={}, url=types.SimpleNamespace(path="/x"))
        self.assertEqual(metrics.normalize_route(req2), "unmatched")


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
            self.assertTrue(metrics.is_authorized("Bearer scraper-secret", None))
            self.assertTrue(metrics.is_authorized(None, "scraper-secret"))
            self.assertFalse(metrics.is_authorized("Bearer nope", None))


class RouteHandlerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        metrics.reset()

    async def test_returns_exposition_when_open(self):
        with _Env(NODE_ENV="development", METRICS_TOKEN="", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest(rag=_FakeRag(7)))
        self.assertEqual(resp.status_code, 200)
        body = resp.body.decode()
        self.assertIn("ecopulse_info", body)
        self.assertIn("ecopulse_doc_chunks_loaded 7", body)

    async def test_disabled_in_production_without_token(self):
        with _Env(NODE_ENV="production", METRICS_TOKEN="", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest())
        self.assertEqual(resp.status_code, 404)

    async def test_unauthorized_without_token_when_protected(self):
        with _Env(NODE_ENV="production", METRICS_TOKEN="secret", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest())
        self.assertEqual(resp.status_code, 401)

    async def test_authorized_with_x_metrics_token(self):
        with _Env(NODE_ENV="production", METRICS_TOKEN="secret", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest({"x-metrics-token": "secret"}))
        self.assertEqual(resp.status_code, 200)

    async def test_missing_rag_reports_zero_chunks(self):
        with _Env(NODE_ENV="development", METRICS_TOKEN="", METRICS_ENABLED="true"):
            resp = await get_metrics(_FakeRequest(rag=None))
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"ecopulse_doc_chunks_loaded 0", resp.body)


if __name__ == "__main__":
    unittest.main()

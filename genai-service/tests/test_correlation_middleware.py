"""Tests for x-request-id correlation propagation (Module 7.4) — genai-service."""
import io
import logging
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import logging_config as genai_lc  # noqa: E402
from app.middleware import request_logging_middleware  # noqa: E402


def _capture(setup_fn):
    buf = io.StringIO()
    original = sys.stdout
    sys.stdout = buf

    def restore():
        sys.stdout = original
        root = logging.getLogger()
        for h in list(root.handlers):
            root.removeHandler(h)
        for f in list(root.filters):
            root.removeFilter(f)

    setup_fn()
    return buf, restore


def _build_app():
    app = FastAPI()
    app.middleware("http")(request_logging_middleware)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    return app


class _FakeRequest:
    def __init__(self, cid=None):
        self.headers = {"x-request-id": cid} if cid is not None else {}
        self.method = "GET"
        self.url = types.SimpleNamespace(path="/health")


class CorrelationEchoTests(unittest.TestCase):
    def setUp(self):
        self.buf, self.restore = _capture(lambda: genai_lc.setup_logging("INFO"))

    def tearDown(self):
        self.restore()
        genai_lc.reset_correlation_id()

    def test_echoes_valid_x_request_id(self):
        client = TestClient(_build_app())
        resp = client.get("/health", headers={"x-request-id": "abc-123"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("x-request-id"), "abc-123")

    def test_generates_id_when_header_absent(self):
        client = TestClient(_build_app())
        resp = client.get("/health")
        echoed = resp.headers.get("x-request-id")
        self.assertIsNotNone(echoed)
        self.assertRegex(echoed, r"^[A-Za-z0-9_-]+$")

    def test_sanitizes_malicious_non_control_value(self):
        client = TestClient(_build_app())
        resp = client.get("/health", headers={"x-request-id": "legit;INJECT stuff"})
        echoed = resp.headers.get("x-request-id")
        self.assertEqual(echoed, "legitINJECTstuff")
        self.assertRegex(echoed, r"^[A-Za-z0-9_-]+$")


class CorrelationBindingAsyncTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.buf, self.restore = _capture(lambda: genai_lc.setup_logging("INFO"))

    def tearDown(self):
        self.restore()
        genai_lc.reset_correlation_id()

    async def test_contextvar_bound_and_echo_with_crlf_input(self):
        seen = {}

        async def call_next(request):
            seen["cid"] = genai_lc.get_correlation_id()
            return JSONResponse({"ok": True}, status_code=200)

        resp = await request_logging_middleware(_FakeRequest("a\rb\ncFAKE"), call_next)
        self.assertEqual(resp.headers["x-request-id"], "abcFAKE")
        self.assertEqual(seen["cid"], "abcFAKE")

    async def test_generates_uuid_when_header_missing(self):
        seen = {}

        async def call_next(request):
            seen["cid"] = genai_lc.get_correlation_id()
            return JSONResponse({"ok": True}, status_code=200)

        resp = await request_logging_middleware(_FakeRequest(None), call_next)
        echoed = resp.headers["x-request-id"]
        self.assertRegex(echoed, r"^[A-Za-z0-9_-]+$")
        self.assertEqual(seen["cid"], echoed)

    async def test_contextvar_reset_after_request(self):
        async def call_next(request):
            return JSONResponse({"ok": True}, status_code=200)

        await request_logging_middleware(_FakeRequest("trace-1"), call_next)
        self.assertIsNone(genai_lc.get_correlation_id())


if __name__ == "__main__":
    unittest.main()

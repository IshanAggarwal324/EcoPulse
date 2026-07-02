"""Tests for W3C traceparent propagation (Module 7.6).

Uses the async direct-call pattern (no TestClient/httpx) so the suite runs
wherever the stdlib + fastapi do. Covers: ingress validation (log-forging /
header-injection defense), fresh-context minting when absent/invalid, response
echo, and contextvar binding so the trace id is available throughout the request.
"""
import io
import logging
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.responses import JSONResponse  # noqa: E402

from app import logging_config as ai_lc  # noqa: E402
from app.middleware import request_logging_middleware  # noqa: E402

VALID_TP = f"00-{'a' * 32}-{'b' * 16}-01"


def _settings(log_level="INFO", log_file=""):
    return types.SimpleNamespace(log_level=log_level, log_file=log_file)


class _FakeRequest:
    def __init__(self, traceparent="unset", x_request_id=None):
        headers = {}
        if traceparent != "unset":
            headers["traceparent"] = traceparent
        if x_request_id is not None:
            headers["x-request-id"] = x_request_id
        self.headers = headers
        self.method = "GET"
        self.url = types.SimpleNamespace(path="/health")
        self.scope = {"route": types.SimpleNamespace(path="/health")}


class _Capture:
    def __init__(self):
        self.buf = io.StringIO()
        self._original = sys.stdout

    def __enter__(self):
        sys.stdout = self.buf
        return self

    def __exit__(self, *exc):
        sys.stdout = self._original
        root = logging.getLogger()
        for h in list(root.handlers):
            root.removeHandler(h)
        for f in list(root.filters):
            root.removeFilter(f)


class SanitizeTraceparentTests(unittest.TestCase):
    def test_accepts_well_formed_and_lowercases(self):
        self.assertEqual(ai_lc.sanitize_traceparent(VALID_TP), VALID_TP)
        self.assertEqual(ai_lc.sanitize_traceparent(VALID_TP.upper()), VALID_TP)

    def test_rejects_hostile_and_malformed(self):
        # CRLF / log-forging / header-injection vectors never survive.
        self.assertIsNone(ai_lc.sanitize_traceparent("00-\r\nINJECT-b-c-01"))
        self.assertIsNone(ai_lc.sanitize_traceparent("not a traceparent"))
        self.assertIsNone(ai_lc.sanitize_traceparent(f"00-{'a' * 31}-{'b' * 16}-01"))  # short trace id
        self.assertIsNone(ai_lc.sanitize_traceparent(f"ff-{'a' * 32}-{'b' * 16}-01"))  # forbidden version
        self.assertIsNone(ai_lc.sanitize_traceparent(f"00-{'0' * 32}-{'b' * 16}-01"))  # all-zero trace id
        self.assertIsNone(ai_lc.sanitize_traceparent(f"00-{'a' * 32}-{'0' * 16}-01"))  # all-zero parent id
        self.assertIsNone(ai_lc.sanitize_traceparent(None))
        self.assertIsNone(ai_lc.sanitize_traceparent(""))

    def test_resolve_trusts_valid_or_mints_fresh(self):
        self.assertEqual(ai_lc.resolve_traceparent(VALID_TP), VALID_TP)
        fresh = ai_lc.resolve_traceparent("garbage")
        self.assertNotEqual(fresh, "garbage")
        self.assertEqual(ai_lc.sanitize_traceparent(fresh), fresh)

    def test_generate_is_schema_conformant_and_unique(self):
        a = ai_lc._generate_traceparent()
        b = ai_lc._generate_traceparent()
        self.assertEqual(ai_lc.sanitize_traceparent(a), a)
        self.assertEqual(ai_lc.sanitize_traceparent(b), b)
        self.assertNotEqual(a, b)


class MiddlewareTraceparentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._capture = _Capture()
        self._capture.__enter__()
        ai_lc.setup_logging(_settings())

    def tearDown(self):
        self._capture.__exit__(None, None, None)
        ai_lc.reset_correlation_id()

    async def test_echoes_valid_inbound_traceparent(self):
        seen = {}

        async def call_next(request):
            seen["tp"] = ai_lc.get_traceparent()
            return JSONResponse({"ok": True}, status_code=200)

        resp = await request_logging_middleware(_FakeRequest(VALID_TP), call_next)
        self.assertEqual(resp.headers["traceparent"], VALID_TP)
        # The contextvar is bound for the duration of the request.
        self.assertEqual(seen["tp"], VALID_TP)

    async def test_replaces_malformed_inbound_with_fresh_context(self):
        async def call_next(request):
            return JSONResponse({"ok": True}, status_code=200)

        resp = await request_logging_middleware(_FakeRequest("evil\r\nINJECT"), call_next)
        echoed = resp.headers["traceparent"]
        # Never trust the hostile value; a fresh valid context is emitted.
        self.assertEqual(ai_lc.sanitize_traceparent(echoed), echoed)
        self.assertNotEqual(echoed, "evil\r\nINJECT")

    async def test_mints_trace_context_when_absent(self):
        async def call_next(request):
            return JSONResponse({"ok": True}, status_code=200)

        resp = await request_logging_middleware(_FakeRequest("unset"), call_next)
        echoed = resp.headers["traceparent"]
        self.assertEqual(ai_lc.sanitize_traceparent(echoed), echoed)


if __name__ == "__main__":
    unittest.main()

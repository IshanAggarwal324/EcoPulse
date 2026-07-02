"""Tests for W3C traceparent propagation in genai-service (Module 7.6).

Uses the async direct-call pattern (no TestClient/httpx) so the suite runs
wherever the stdlib + fastapi do.
"""
import io
import logging
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.responses import JSONResponse  # noqa: E402

from app import logging_config as genai_lc  # noqa: E402
from app.middleware import request_logging_middleware  # noqa: E402

VALID_TP = f"00-{'a' * 32}-{'b' * 16}-01"


class _FakeRequest:
    def __init__(self, traceparent="unset", x_request_id=None):
        headers = {}
        if traceparent != "unset":
            headers["traceparent"] = traceparent
        if x_request_id is not None:
            headers["x-request-id"] = x_request_id
        self.headers = headers
        self.method = "POST"
        self.url = types.SimpleNamespace(path="/assistant/chat")
        self.scope = {"route": types.SimpleNamespace(path="/assistant/chat")}


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
        self.assertEqual(genai_lc.sanitize_traceparent(VALID_TP), VALID_TP)
        self.assertEqual(genai_lc.sanitize_traceparent(VALID_TP.upper()), VALID_TP)

    def test_rejects_hostile_and_malformed(self):
        self.assertIsNone(genai_lc.sanitize_traceparent("00-\r\nINJECT-b-c-01"))
        self.assertIsNone(genai_lc.sanitize_traceparent("not a traceparent"))
        self.assertIsNone(genai_lc.sanitize_traceparent(f"00-{'0' * 32}-{'b' * 16}-01"))
        self.assertIsNone(genai_lc.sanitize_traceparent(f"ff-{'a' * 32}-{'b' * 16}-01"))
        self.assertIsNone(genai_lc.sanitize_traceparent(None))
        self.assertIsNone(genai_lc.sanitize_traceparent(""))

    def test_resolve_trusts_valid_or_mints_fresh(self):
        self.assertEqual(genai_lc.resolve_traceparent(VALID_TP), VALID_TP)
        fresh = genai_lc.resolve_traceparent("garbage")
        self.assertEqual(genai_lc.sanitize_traceparent(fresh), fresh)


class MiddlewareTraceparentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._capture = _Capture()
        self._capture.__enter__()
        genai_lc.setup_logging("INFO")

    def tearDown(self):
        self._capture.__exit__(None, None, None)
        genai_lc.reset_correlation_id()

    async def test_echoes_valid_inbound_traceparent(self):
        seen = {}

        async def call_next(request):
            seen["tp"] = genai_lc.get_traceparent()
            return JSONResponse({"ok": True}, status_code=200)

        resp = await request_logging_middleware(_FakeRequest(VALID_TP), call_next)
        self.assertEqual(resp.headers["traceparent"], VALID_TP)
        self.assertEqual(seen["tp"], VALID_TP)

    async def test_replaces_malformed_inbound_with_fresh_context(self):
        async def call_next(request):
            return JSONResponse({"ok": True}, status_code=200)

        resp = await request_logging_middleware(_FakeRequest("evil\r\nINJECT"), call_next)
        echoed = resp.headers["traceparent"]
        self.assertEqual(genai_lc.sanitize_traceparent(echoed), echoed)
        self.assertNotEqual(echoed, "evil\r\nINJECT")

    async def test_mints_trace_context_when_absent(self):
        async def call_next(request):
            return JSONResponse({"ok": True}, status_code=200)

        resp = await request_logging_middleware(_FakeRequest("unset"), call_next)
        echoed = resp.headers["traceparent"]
        self.assertEqual(genai_lc.sanitize_traceparent(echoed), echoed)


if __name__ == "__main__":
    unittest.main()

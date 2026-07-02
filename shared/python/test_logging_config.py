"""Tests for the canonical shared structured logger (Module 7.3)."""
import io
import json
import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from observability import logging_config as lc  # noqa: E402


def _capture(setup_fn):
    """Reconfigure logging to write into a buffer, return (buf, restore)."""
    buf = io.StringIO()
    original = sys.stdout
    sys.stdout = buf

    def restore():
        sys.stdout = original
        root = logging.getLogger()
        for handler in list(root.handlers):
            root.removeHandler(handler)
        for flt in list(root.filters):
            root.removeFilter(flt)

    setup_fn()
    return buf, restore


def _last_json(buf):
    lines = [ln for ln in buf.getvalue().splitlines() if ln.strip()]
    return json.loads(lines[-1])


class SetupLoggingTests(unittest.TestCase):
    def setUp(self):
        lc._ACTIVE_SERVICE = lc.SERVICE_DEFAULT
        lc.reset_correlation_id()

    def tearDown(self):
        logging.getLogger().handlers.clear()
        logging.getLogger().filters.clear()

    def test_setup_logging_emits_json_with_required_fields(self):
        buf, restore = _capture(lambda: lc.setup_logging(service="ecopulse-test", log_level="INFO"))
        try:
            logging.getLogger("t").info("hello world")
        finally:
            restore()
        entry = _last_json(buf)
        self.assertEqual(entry["level"], "info")
        self.assertEqual(entry["msg"], "hello world")
        self.assertEqual(entry["service"], "ecopulse-test")
        self.assertIn("ts", entry)
        # ISO-8601 timestamp is parseable.
        __import__("datetime").datetime.fromisoformat(entry["ts"])

    def test_level_filtering_respects_log_level(self):
        buf, restore = _capture(lambda: lc.setup_logging(service="t", log_level="WARNING"))
        try:
            logging.getLogger("t").debug("should-not-appear")
            logging.getLogger("t").warning("should-appear")
        finally:
            restore()
        line = buf.getvalue().strip()
        self.assertNotIn("should-not-appear", line)
        self.assertIn("should-appear", line)

    def test_text_format_when_log_format_text(self):
        buf, restore = _capture(lambda: lc.setup_logging(service="t", log_format="text"))
        try:
            logging.getLogger("t").info("plain message")
        finally:
            restore()
        out = buf.getvalue().strip()
        self.assertNotIn('"msg"', out)  # not JSON
        self.assertIn("plain message", out)

    def test_log_access_emits_request_fields(self):
        buf, restore = _capture(lambda: lc.setup_logging(service="t", log_level="INFO"))
        try:
            lc.log_access(logging.getLogger("access"), "POST", "/forecast", 200, 12.4)
        finally:
            restore()
        entry = _last_json(buf)
        self.assertEqual(entry["method"], "POST")
        self.assertEqual(entry["path"], "/forecast")
        self.assertEqual(entry["status"], 200)
        self.assertEqual(entry["durationMs"], 12.4)
        self.assertEqual(entry["level"], "info")


class CorrelationTests(unittest.TestCase):
    def tearDown(self):
        lc.reset_correlation_id()
        logging.getLogger().handlers.clear()
        logging.getLogger().filters.clear()

    def test_correlation_id_appears_when_bound(self):
        buf, restore = _capture(lambda: lc.setup_logging(service="t", log_level="INFO"))
        try:
            with lc.correlation_context("req-abc"):
                logging.getLogger("t").info("scoped")
            logging.getLogger("t").info("unscoped")
        finally:
            restore()
        lines = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.strip()]
        scoped = next(e for e in lines if e["msg"] == "scoped")
        unscoped = next(e for e in lines if e["msg"] == "unscoped")
        self.assertEqual(scoped["correlationId"], "req-abc")
        self.assertNotIn("correlationId", unscoped)

    def test_reset_clears_correlation_id(self):
        lc.bind_correlation_id("x")
        self.assertEqual(lc.get_correlation_id(), "x")
        lc.reset_correlation_id()
        self.assertIsNone(lc.get_correlation_id())


class CorrelationSanitizerTests(unittest.TestCase):
    """Module 7.4 — untrusted x-request-id must never carry control chars."""

    def test_safe_value_passes_through(self):
        self.assertEqual(lc.sanitize_correlation_id("abc-123_xyz"), "abc-123_xyz")
        self.assertEqual(
            lc.sanitize_correlation_id("550e8400-e29b-41d4-a716-446655440000"),
            "550e8400-e29b-41d4-a716-446655440000",
        )

    def test_control_chars_are_stripped(self):
        # CR/LF are the log-forging / header-injection vectors.
        self.assertEqual(lc.sanitize_correlation_id("a\rb\nc"), "abc")
        self.assertEqual(lc.sanitize_correlation_id('ev"il; /tmp/'), "eviltmp")

    def test_empty_or_garbage_returns_none(self):
        for bad in (None, "", "   ", "\r\n\r\n", "\x00\x01"):
            self.assertIsNone(lc.sanitize_correlation_id(bad))

    def test_over_length_value_rejected(self):
        long_ok = "a" * lc.MAX_CORRELATION_ID_LENGTH
        self.assertEqual(lc.sanitize_correlation_id(long_ok), long_ok)
        self.assertIsNone(lc.sanitize_correlation_id("a" * (lc.MAX_CORRELATION_ID_LENGTH + 1)))

    def test_resolve_returns_sanitized_or_uuid(self):
        self.assertEqual(lc.resolve_request_correlation_id("good-id"), "good-id")
        gen = lc.resolve_request_correlation_id("bad value!")
        self.assertRegex(gen, r"^[A-Za-z0-9_-]+$")
        self.assertGreater(len(gen), 0)
        self.assertNotEqual(
            lc.resolve_request_correlation_id(None),
            lc.resolve_request_correlation_id(None),
        )

    def test_bind_sanitizes_untrusted_value(self):
        # Even if a caller forgets to resolve, bind() never stores control chars.
        lc.bind_correlation_id("a\rb\nc")
        self.assertEqual(lc.get_correlation_id(), "abc")
        lc.reset_correlation_id()


class SecurityTests(unittest.TestCase):
    def tearDown(self):
        logging.getLogger().handlers.clear()
        logging.getLogger().filters.clear()

    def test_formatter_does_not_echo_arbitrary_extras_outside_whitelist(self):
        buf, restore = _capture(lambda: lc.setup_logging(service="t", log_level="INFO"))
        try:
            # Only whitelisted extras are surfaced; a stray secret extra is dropped.
            logging.getLogger("t").info("msg", extra={"secret": "LEAK", "path": "/p"})
        finally:
            restore()
        entry = _last_json(buf)
        self.assertNotIn("secret", entry)
        self.assertEqual(entry["path"], "/p")

    def test_exception_message_is_captured_without_stack(self):
        buf, restore = _capture(lambda: lc.setup_logging(service="t", log_level="ERROR"))
        try:
            try:
                raise ValueError("boom detail")
            except ValueError:
                logging.getLogger("t").exception("failed op")
        finally:
            restore()
        entry = _last_json(buf)
        self.assertEqual(entry["level"], "error")
        self.assertEqual(entry["err"]["message"], "boom detail")


if __name__ == "__main__":
    unittest.main()

"""Tests for ai_service logging bootstrap (Module 7.3).

In dev these run with ``shared/python`` resolvable, so they exercise the shared
implementation through the wrapper. A dedicated parity test forces the inline
fallback to assert it emits an identical schema.
"""
import io
import json
import logging
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import logging_config as ai_lc  # noqa: E402


def _settings(log_level="INFO", log_file=""):
    return types.SimpleNamespace(log_level=log_level, log_file=log_file)


def _capture(setup_fn):
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


class AiServiceLoggingTests(unittest.TestCase):
    def tearDown(self):
        logging.getLogger().handlers.clear()
        logging.getLogger().filters.clear()

    def test_setup_logging_uses_ai_service_name(self):
        buf, restore = _capture(lambda: ai_lc.setup_logging(_settings()))
        try:
            logging.getLogger("t").info("boot ok")
        finally:
            restore()
        entry = _last_json(buf)
        self.assertEqual(entry["service"], "ecopulse-ai-service")
        self.assertEqual(entry["level"], "info")
        self.assertEqual(entry["msg"], "boot ok")
        self.assertIn("ts", entry)

    def test_access_log_request_fields_are_emitted(self):
        buf, restore = _capture(lambda: ai_lc.setup_logging(_settings()))
        try:
            logging.getLogger("ecopulse.access").info(
                "POST /forecast -> 200",
                extra={"method": "POST", "path": "/forecast", "status": 200, "durationMs": 7.5},
            )
        finally:
            restore()
        entry = _last_json(buf)
        self.assertEqual(entry["path"], "/forecast")
        self.assertEqual(entry["status"], 200)
        self.assertEqual(entry["durationMs"], 7.5)


class FallbackParityTests(unittest.TestCase):
    def tearDown(self):
        logging.getLogger().handlers.clear()
        logging.getLogger().filters.clear()
        ai_lc._shared_root.cache_clear() if hasattr(ai_lc._shared_root, "cache_clear") else None

    def test_inline_fallback_emits_same_schema_as_shared(self):
        # Shared path.
        buf_shared, restore_shared = _capture(lambda: ai_lc.setup_logging(_settings()))
        try:
            logging.getLogger("t").info("cmp", extra={"path": "/x", "status": 201})
        finally:
            restore_shared()
        shared_entry = _last_json(buf_shared)

        # Force the inline fallback by hiding the shared package.
        original = ai_lc._shared_root
        ai_lc._shared_root = lambda: None
        try:
            buf_fb, restore_fb = _capture(lambda: ai_lc.setup_logging(_settings()))
            try:
                logging.getLogger("t").info("cmp", extra={"path": "/x", "status": 201})
            finally:
                restore_fb()
            fallback_entry = _last_json(buf_fb)
        finally:
            ai_lc._shared_root = original

        # Same key set (ts differs in value, not presence) and matching values.
        self.assertEqual(
            set(shared_entry.keys()) - {"ts"},
            set(fallback_entry.keys()) - {"ts"},
        )
        for key in (set(shared_entry.keys()) - {"ts"}):
            self.assertEqual(shared_entry[key], fallback_entry[key], key)


if __name__ == "__main__":
    unittest.main()

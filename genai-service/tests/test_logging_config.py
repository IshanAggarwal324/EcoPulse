"""Tests for genai-service logging bootstrap (Module 7.3)."""
import io
import json
import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import logging_config as genai_lc  # noqa: E402


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


class GenaiLoggingTests(unittest.TestCase):
    def tearDown(self):
        logging.getLogger().handlers.clear()
        logging.getLogger().filters.clear()

    def test_setup_logging_uses_genai_service_name(self):
        buf, restore = _capture(lambda: genai_lc.setup_logging("INFO"))
        try:
            logging.getLogger("t").info("boot ok")
        finally:
            restore()
        entry = _last_json(buf)
        self.assertEqual(entry["service"], "ecopulse-genai-service")
        self.assertEqual(entry["msg"], "boot ok")
        self.assertEqual(entry["level"], "info")

    def test_access_log_request_fields_are_emitted(self):
        buf, restore = _capture(lambda: genai_lc.setup_logging("INFO"))
        try:
            logging.getLogger("ecopulse.access").info(
                "POST /assistant/chat -> 200",
                extra={"method": "POST", "path": "/assistant/chat", "status": 200, "durationMs": 3.2},
            )
        finally:
            restore()
        entry = _last_json(buf)
        self.assertEqual(entry["path"], "/assistant/chat")
        self.assertEqual(entry["status"], 200)
        self.assertEqual(entry["durationMs"], 3.2)


class FallbackParityTests(unittest.TestCase):
    def tearDown(self):
        logging.getLogger().handlers.clear()
        logging.getLogger().filters.clear()

    def test_inline_fallback_emits_same_schema_as_shared(self):
        buf_shared, restore_shared = _capture(lambda: genai_lc.setup_logging("INFO"))
        try:
            logging.getLogger("t").info("cmp", extra={"path": "/y", "status": 200})
        finally:
            restore_shared()
        shared_entry = _last_json(buf_shared)

        original = genai_lc._shared_root
        genai_lc._shared_root = lambda: None
        try:
            buf_fb, restore_fb = _capture(lambda: genai_lc.setup_logging("INFO"))
            try:
                logging.getLogger("t").info("cmp", extra={"path": "/y", "status": 200})
            finally:
                restore_fb()
            fallback_entry = _last_json(buf_fb)
        finally:
            genai_lc._shared_root = original

        self.assertEqual(
            set(shared_entry.keys()) - {"ts"},
            set(fallback_entry.keys()) - {"ts"},
        )
        for key in (set(shared_entry.keys()) - {"ts"}):
            self.assertEqual(shared_entry[key], fallback_entry[key], key)


if __name__ == "__main__":
    unittest.main()

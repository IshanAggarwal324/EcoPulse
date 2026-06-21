"""Tests for production env guards (H4)."""
import os
import sys
import unittest
from importlib import reload
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app.env_utils as env_utils  # noqa: E402


class EnvUtilsTests(unittest.TestCase):
    def test_debug_blocked_in_production(self):
        with patch.dict(os.environ, {"NODE_ENV": "production", "DEBUG": "true"}, clear=False):
            reload(env_utils)
            with self.assertRaises(RuntimeError):
                env_utils.resolve_debug_flag()

    def test_debug_allowed_in_development(self):
        with patch.dict(os.environ, {"NODE_ENV": "development", "DEBUG": "true"}, clear=False):
            reload(env_utils)
            self.assertTrue(env_utils.resolve_debug_flag())

    def test_is_production(self):
        with patch.dict(os.environ, {"NODE_ENV": "production"}, clear=False):
            reload(env_utils)
            self.assertTrue(env_utils.is_production())


if __name__ == "__main__":
    unittest.main()

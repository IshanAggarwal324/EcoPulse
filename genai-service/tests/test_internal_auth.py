"""Tests for internal service API-key gate."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.internal_auth import internal_auth_response  # noqa: E402


class InternalAuthResponseTests(unittest.TestCase):
    def test_health_paths_are_not_blocked(self):
        self.assertIsNone(internal_auth_response("/health", "", None))

    def test_missing_configured_key_returns_503(self):
        response = internal_auth_response("/assistant/chat", "", None)
        self.assertIsNotNone(response)
        self.assertEqual(response.status_code, 503)

    def test_wrong_key_returns_401(self):
        response = internal_auth_response("/assistant/chat", "secret", "wrong")
        self.assertIsNotNone(response)
        self.assertEqual(response.status_code, 401)

    def test_matching_key_allows_request(self):
        self.assertIsNone(internal_auth_response("/assistant/chat", "secret", "secret"))


if __name__ == "__main__":
    unittest.main()

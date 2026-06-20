"""Sub-module 3.3 — prompt engineering & answer quality (pure-logic tests).

Run:  python -m unittest tests.test_prompt_engineering   (from genai-service/)
       or  python tests/test_prompt_engineering.py
No Gemini / network required.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.prompts import (  # noqa: E402
    build_assistant_chat_prompt,
    _extract_comparison_insights,
)
from app.services.fallback_templates import render_chat_reply  # noqa: E402


class ComparisonInsightsTests(unittest.TestCase):
    def test_delta_percent_is_directional(self):
        out = _extract_comparison_insights(
            {"totalConsumedKwh": 142, "priorPeriodConsumedKwh": 98, "deltaPercent": 45}
        )
        self.assertTrue(any("up 45%" in i for i in out))
        out_down = _extract_comparison_insights(
            {"totalConsumedKwh": 80, "priorPeriodConsumedKwh": 100, "deltaPercent": -20}
        )
        self.assertTrue(any("down 20%" in i for i in out_down))

    def test_anomalies_surfaces_reason(self):
        out = _extract_comparison_insights(
            {"anomalies": [{"name": "Home Solar", "reason": "up 100% vs prior"}]}
        )
        self.assertTrue(any("Home Solar" in i and "100%" in i for i in out))

    def test_unit_price_trend_first_to_last(self):
        out = _extract_comparison_insights(
            {"unitPriceTrend": [{"avgUnitPriceCc": 0.05}, {"avgUnitPriceCc": 0.09}]}
        )
        self.assertTrue(any("0.05" in i and "0.09" in i for i in out))

    def test_active_listings_count(self):
        out = _extract_comparison_insights({"activeListings": 7})
        self.assertTrue(any("7 listings" in i for i in out))

    def test_empty_or_none(self):
        self.assertEqual(_extract_comparison_insights(None), [])
        self.assertEqual(_extract_comparison_insights({}), [])


class PromptStructureTests(unittest.TestCase):
    def _build(self, **kw):
        sys_p, user_p = build_assistant_chat_prompt(message="why is my bill high?", **kw)
        return sys_p, user_p

    def test_live_data_is_fenced_and_untrusted(self):
        _, user_p = self._build(retrieved_data={"totalConsumedKwh": 142})
        self.assertIn("<<<LIVE_DATA>>>", user_p)
        self.assertIn("142", user_p)

    def test_doc_excerpts_marked_untrusted(self):
        from app.schemas.genai import DocChunk

        chunk = DocChunk(docId="trading-guide.md", title="How to sell", excerpt="Use the form")
        _, user_p = self._build(doc_chunks=[chunk])
        self.assertIn("<<<DOCUMENT_EXCERPTS", user_p)
        self.assertIn("UNTRUSTED", user_p)

    def test_user_context_section_present(self):
        _, user_p = self._build(user_context={"pageContext": "dashboard"})
        self.assertIn("<<<USER_CONTEXT>>>", user_p)
        self.assertIn("dashboard", user_p)

    def test_comparison_insights_section_when_bill_data(self):
        _, user_p = self._build(
            retrieved_data={"totalConsumedKwh": 142, "priorPeriodConsumedKwh": 98, "deltaPercent": 45}
        )
        self.assertIn("<<<COMPARISON_INSIGHTS>>>", user_p)

    def test_bill_template_only_for_bill_intent(self):
        sys_bill, _ = self._build(intent="bill_analysis", retrieved_data={"totalConsumedKwh": 1})
        sys_other, _ = self._build(intent="forecast", retrieved_data={"available": True})
        self.assertIn("BILL ANALYSIS GUIDANCE", sys_bill)
        self.assertNotIn("BILL ANALYSIS GUIDANCE", sys_other)

    def test_grounding_rule_in_system_prompt(self):
        sys_p, _ = self._build()
        self.assertIn("don't have enough data", sys_p)
        # JSON output schema preserved (3.3.4)
        self.assertIn('"reply"', sys_p)

    def test_injection_guard_in_system_prompt(self):
        sys_p, _ = self._build()
        self.assertIn("UNTRUSTED", sys_p)


class FallbackTemplateTests(unittest.TestCase):
    def test_bill_shape_renders_delta_and_top_nodes(self):
        reply = render_chat_reply(
            "why high?",
            {
                "totalConsumedKwh": 142,
                "priorPeriodConsumedKwh": 98,
                "deltaPercent": 45,
                "topNodes": [{"name": "Home Solar", "consumedKwh": 80}],
            },
            intent="bill_analysis",
        )
        self.assertIn("142", reply)
        self.assertIn("up 45%", reply)
        self.assertIn("Home Solar", reply)

    def test_explanation_only_payload(self):
        reply = render_chat_reply("hi", {"explanation": "No wallet connected."})
        self.assertEqual(reply, "No wallet connected.")

    def test_no_data_default(self):
        reply = render_chat_reply("hi", None)
        self.assertIn("live data", reply.lower())

    def test_trades_with_active_listings_and_trend(self):
        reply = render_chat_reply(
            "trades?",
            {
                "completedTrades": 5,
                "totalEnergyTraded": 120,
                "activeListings": 3,
                "unitPriceTrend": [{"avgUnitPriceCc": 0.05}, {"avgUnitPriceCc": 0.08}],
            },
        )
        self.assertIn("3", reply)
        self.assertIn("0.08", reply)

    def test_user_nodes_shape(self):
        reply = render_chat_reply(
            "my nodes",
            {"nodeCount": 2, "activeCount": 1, "nodes": [{"name": "Home Solar"}, {"name": "Wind"}]},
        )
        self.assertIn("Home Solar", reply)
        self.assertIn("2", reply)


if __name__ == "__main__":
    unittest.main()

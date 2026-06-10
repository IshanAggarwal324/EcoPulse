import json
import logging
import re

from fastapi import APIRouter, Request

from app.schemas.genai import ReportNarrateRequest, ReportNarrateResponse
from app.services.fallback_templates import render_report_summary
from app.services.llm_service import LlmService
from app.services.prompts import build_report_narrate_prompt

router = APIRouter(prefix="/reports", tags=["Reports"])
logger = logging.getLogger(__name__)


def _parse_narrate_response(text: str, fallback_summary: str, meta_is_demo: bool) -> ReportNarrateResponse:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        logger.warning("Failed to parse narrate JSON — using fallback summary")
        return ReportNarrateResponse(
            summary=fallback_summary,
            highlights=["See detailed summary above."],
            disclaimer="Based on simulated demo data." if meta_is_demo else "Based on live platform data.",
        )

    try:
        return ReportNarrateResponse(
            summary=parsed.get("summary", fallback_summary),
            highlights=parsed.get("highlights", ["See detailed summary above."]),
            disclaimer=parsed.get("disclaimer", "Based on simulated demo data." if meta_is_demo else "Based on live platform data."),
        )
    except Exception:
        logger.warning("Narrate response validation failed — using fallback summary")
        return ReportNarrateResponse(
            summary=fallback_summary,
            highlights=["See detailed summary above."],
            disclaimer="Based on simulated demo data." if meta_is_demo else "Based on live platform data.",
        )


@router.post("/narrate", response_model=ReportNarrateResponse)
async def narrate_report(request: ReportNarrateRequest, http_request: Request):
    llm: LlmService = http_request.app.state.llm_service

    metrics_dict = request.metrics.model_dump(by_alias=True, exclude_none=True)
    metrics_dict["meta"] = request.meta.model_dump(by_alias=True)
    fallback_summary = render_report_summary(metrics_dict)

    if not llm.is_available():
        logger.info("Gemini unavailable — returning fallback report summary")
        return ReportNarrateResponse(
            summary=fallback_summary,
            highlights=["Report generated in offline mode."],
            disclaimer="Based on simulated demo data." if request.meta.is_demo_data else "Based on live platform data.",
        )

    system_prompt, user_prompt = build_report_narrate_prompt(
        request.metrics, request.meta
    )

    try:
        result = llm.complete(system_prompt, user_prompt)
        return _parse_narrate_response(
            result.text,
            fallback_summary,
            request.meta.is_demo_data,
        )
    except Exception:
        logger.exception("Gemini narrate call failed — returning fallback report summary")
        return ReportNarrateResponse(
            summary=fallback_summary,
            highlights=["Report generated in offline mode."],
            disclaimer="Based on simulated demo data." if request.meta.is_demo_data else "Based on live platform data.",
        )

import json
from typing import Any

from app.schemas.genai import ReportMeta, ReportMetrics


def build_report_narrate_prompt(
    metrics: ReportMetrics,
    meta: ReportMeta,
) -> tuple[str, str]:
    system_prompt = (
        "You are the EcoPulse Energy Report Assistant.\n"
        "Your task is to write a clear, concise narrative report from pre-computed metrics.\n\n"
        "STRICT RULES:\n"
        "- You MUST only use numbers that appear in the provided metrics JSON.\n"
        "- Do NOT round beyond one decimal place unless the source data does so.\n"
        "- Do NOT invent, estimate, or extrapolate any values.\n"
        "- If a section (e.g. personalProfit, carbon) is missing or null, state that the data "
        "is unavailable rather than guessing.\n"
        "- Omit any section for which no data is provided.\n"
        "- Write in a professional but accessible tone.\n"
        "- Use metric units (kWh for energy, CC for carbon credits).\n\n"
        "OUTPUT FORMAT — respond with a JSON object:\n"
        '{\n'
        '  "summary": "2-4 paragraph narrative covering the available sections.",\n'
        '  "highlights": ["3-5 short bullet-point highlights, each a single sentence."],\n'
        '  "disclaimer": "A one-line data source notice."\n'
        '}'
    )

    metrics_dict = metrics.model_dump(by_alias=True, exclude_none=True)
    meta_dict = meta.model_dump(by_alias=True)

    if meta.is_demo_data:
        system_prompt += (
            '\n\nIMPORTANT: The data is simulated/demo data. '
            'The disclaimer MUST state "Based on simulated demo data."'
        )

    user_prompt = (
        f"Report period: {meta.period} ({meta_dict.get('period', '')}), "
        f"scope: {meta.scope}.\n\n"
        f"Metrics JSON:\n{json.dumps(metrics_dict, indent=2)}"
    )

    return system_prompt, user_prompt

import json
import logging
import re

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.schemas.genai import AssistantChatRequest, AssistantChatResponse
from app.services.fallback_templates import render_chat_reply
from app.services.llm_service import LlmService
from app.services.prompts import build_assistant_chat_prompt, trim_history

router = APIRouter(prefix="/assistant", tags=["Assistant"])
logger = logging.getLogger(__name__)

_DEFAULT_DISCLAIMER = "Based on simulated demo data."

# Output-sanitization (3.3 guardrail): strip HTML/tags and script-ish content
# from model replies. The assistant is a plain-text chat; no markup should
# reach the UI.
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<\s*script", re.IGNORECASE)


def _sanitize_reply(text: str) -> str:
    if not text:
        return ""
    cleaned = _TAG_RE.sub("", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:4000]


class DocChunksRequest(BaseModel):
    query: str = Field(
        min_length=1,
        max_length=500,
        description="Search query for document retrieval",
    )
    top_k: int = Field(default=3, ge=1, le=10, description="Number of chunks to return")


def _parse_chat_response(
    text: str,
    fallback_reply: str,
    is_demo: bool,
) -> AssistantChatResponse:
    cleaned = re.sub(
        r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE
    ).strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        logger.warning("Failed to parse chat JSON — using fallback reply")
        return AssistantChatResponse(
            reply=fallback_reply,
            disclaimer=_DEFAULT_DISCLAIMER if is_demo else "Based on live platform data.",
        )

    try:
        raw_reply = parsed.get("reply", fallback_reply)
        # Guardrail: reject script-bearing replies outright; strip any other tags.
        if _SCRIPT_RE.search(raw_reply or ""):
            logger.warning("Stripped script-bearing model reply")
            raw_reply = fallback_reply
        return AssistantChatResponse(
            reply=_sanitize_reply(raw_reply),
            disclaimer=parsed.get(
                "disclaimer",
                _DEFAULT_DISCLAIMER if is_demo else "Based on live platform data.",
            ),
        )
    except Exception:
        logger.warning("Chat response validation failed — using fallback reply")
        return AssistantChatResponse(
            reply=fallback_reply,
            disclaimer=_DEFAULT_DISCLAIMER if is_demo else "Based on live platform data.",
        )


@router.post("/chat", response_model=AssistantChatResponse)
async def post_assistant_chat(request: AssistantChatRequest, http_request: Request):
    llm: LlmService = http_request.app.state.llm_service

    history = trim_history(request.conversation_history or [])
    safe_message = request.message.strip()[:1200]

    system_prompt, user_prompt = build_assistant_chat_prompt(
        message=safe_message,
        retrieved_data=request.retrieved_data,
        doc_chunks=request.doc_chunks,
        intent=request.intent,
        user_context=request.user_context,
    )

    if history:
        history_text = "\n".join(
            f"{turn.role.capitalize()}: {turn.content}" for turn in history
        )
        user_prompt = f"Conversation history:\n{history_text}\n\n{user_prompt}"

    fallback_reply = render_chat_reply(safe_message, request.retrieved_data, request.intent)
    is_demo = bool(
        request.retrieved_data and request.retrieved_data.get("meta", {}).get("isDemoData", True)
    )

    if not llm.is_available():
        logger.info("Gemini unavailable — returning fallback chat reply")
        return AssistantChatResponse(
            reply=fallback_reply,
            disclaimer=_DEFAULT_DISCLAIMER if is_demo else "Based on live platform data.",
        )

    try:
        result = llm.complete(system_prompt, user_prompt)
        return _parse_chat_response(result.text, fallback_reply, is_demo)
    except Exception:
        logger.exception("Gemini chat call failed — returning fallback reply")
        return AssistantChatResponse(
            reply=fallback_reply,
            disclaimer=_DEFAULT_DISCLAIMER if is_demo else "Based on live platform data.",
        )


@router.post("/doc-chunks")
async def get_doc_chunks(request: DocChunksRequest, http_request: Request):
    rag = getattr(http_request.app.state, "doc_rag_service", None)
    if not rag or not rag.is_available:
        return {"chunks": []}
    chunks = rag.retrieveDocChunks(request.query.strip(), top_k=request.top_k)
    return {"chunks": chunks}


@router.post("/reindex")
async def reindex_docs(http_request: Request):
    """Rebuild the doc RAG embedding cache from DOCS_DIR.

    Protected by the internal API key middleware (every non-/health path is).
    Only the configured docs directory is ever read.
    """
    rag = getattr(http_request.app.state, "doc_rag_service", None)
    if rag is None:
        return {"reindexed": False, "detail": "Doc RAG service not initialized"}
    result = rag.rebuild()
    return result

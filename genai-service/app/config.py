import os
from dataclasses import dataclass
from functools import lru_cache

from app.env_utils import resolve_debug_flag


def _parse_origins(value: str) -> list[str]:
    return [origin.strip() for origin in value.split(",") if origin.strip()]


@dataclass(frozen=True)
class Settings:
    app_name: str = "EcoPulse GenAI Service"
    app_version: str = "1.0.0"
    debug: bool = False

    port: int = 8001
    host: str = "127.0.0.1"
    log_level: str = "INFO"
    cors_origins: tuple[str, ...] = ()
    internal_api_key: str = ""

    gemini_api_key: str = ""
    # gemini-2.0-flash was shut down on 2026-06-01; gemini-3.6-flash is Google's
    # recommended replacement. See https://ai.google.dev/gemini-api/docs/deprecations
    genai_model: str = "gemini-3.6-flash"
    genai_enabled: bool = True
    genai_max_tokens: int = 800
    genai_max_input_chars: int = 12000
    genai_call_timeout_seconds: int = 8
    # Gemini 3 models spend output tokens on "thinking" by default, which can
    # starve the short replies this service needs. "minimal" keeps latency and
    # token use low. Set GENAI_THINKING_LEVEL to "" to send no thinking config
    # (required for models that do not support it, e.g. older Gemini families).
    genai_thinking_level: str = "minimal"

    # Live /health probe of the Gemini API. Results are cached for the TTL so
    # frequent orchestrator pings never turn into frequent billable calls.
    genai_health_probe_enabled: bool = True
    genai_health_probe_ttl_seconds: int = 60
    genai_health_probe_timeout_seconds: int = 4

    # text-embedding-004 was shut down on 2026-01-14.
    embedding_model: str = "gemini-embedding-001"
    embedding_dimensions: int = 768
    docs_dir: str = ""
    embedding_cache_path: str = ""

    @property
    def genai_available(self) -> bool:
        return self.genai_enabled and bool(self.gemini_api_key)

    @property
    def embedding_available(self) -> bool:
        return bool(self.gemini_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings(
        debug=resolve_debug_flag(),
        port=int(os.getenv("GENAI_PORT", "8001")),
        host=os.getenv("GENAI_HOST", "127.0.0.1"),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        cors_origins=tuple(_parse_origins(os.getenv("GENAI_CORS_ORIGINS", ""))),
        internal_api_key=os.getenv("INTERNAL_SERVICE_API_KEY", ""),
        gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
        genai_model=os.getenv("GENAI_MODEL", "gemini-3.6-flash"),
        genai_enabled=os.getenv("GENAI_ENABLED", "true").lower()
        in ("1", "true", "yes"),
        genai_max_tokens=int(os.getenv("GENAI_MAX_TOKENS", "800")),
        genai_max_input_chars=int(os.getenv("GENAI_MAX_INPUT_CHARS", "12000")),
        genai_call_timeout_seconds=int(os.getenv("GENAI_CALL_TIMEOUT_SECONDS", "8")),
        genai_thinking_level=os.getenv("GENAI_THINKING_LEVEL", "minimal").strip().lower(),
        genai_health_probe_enabled=os.getenv("GENAI_HEALTH_PROBE_ENABLED", "true").lower()
        in ("1", "true", "yes"),
        genai_health_probe_ttl_seconds=int(os.getenv("GENAI_HEALTH_PROBE_TTL_SECONDS", "60")),
        genai_health_probe_timeout_seconds=int(
            os.getenv("GENAI_HEALTH_PROBE_TIMEOUT_SECONDS", "4")
        ),
        embedding_model=os.getenv("EMBEDDING_MODEL", "gemini-embedding-001"),
        embedding_dimensions=int(os.getenv("EMBEDDING_DIMENSIONS", "768")),
        docs_dir=os.getenv("DOCS_DIR", ""),
        embedding_cache_path=os.getenv("EMBEDDING_CACHE_PATH", ""),
    )

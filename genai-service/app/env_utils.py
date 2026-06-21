import os


def is_production() -> bool:
    env = (os.getenv("NODE_ENV") or os.getenv("ENVIRONMENT") or "").lower()
    return env == "production"


def resolve_debug_flag() -> bool:
    raw = os.getenv("DEBUG", "false").lower()
    enabled = raw in ("1", "true", "yes")
    if is_production() and enabled:
        raise RuntimeError("DEBUG cannot be enabled in production")
    return enabled and not is_production()

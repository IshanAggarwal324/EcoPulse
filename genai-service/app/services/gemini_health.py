"""Cached live Gemini reachability probe for the /health route.

``/health*`` is exempt from the internal API-key gate (orchestrators probe it
without credentials), so a naive "call Gemini on every request" check would let
anyone burn quota. This wrapper bounds the cost: at most one real call per TTL
window regardless of how many callers hit the route, with concurrent callers
sharing the in-flight result.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable

from app.services.llm_service import REASON_OK, LlmService

# Failures are re-checked sooner than successes so recovery is noticed quickly.
_MAX_FAILURE_TTL_SECONDS = 15


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    reason: str
    latency_ms: int


class GeminiHealthProbe:
    def __init__(
        self,
        llm: LlmService,
        *,
        ttl_seconds: float = 60,
        timeout_seconds: float = 4,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._llm = llm
        self._ttl = max(0.0, float(ttl_seconds))
        self._timeout = timeout_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._result: ProbeResult | None = None
        self._expires_at = 0.0

    def check(self) -> ProbeResult:
        # The lock is held across the network call on purpose: callers that
        # arrive during a probe wait for it and reuse its result instead of
        # each firing their own request.
        with self._lock:
            now = self._clock()
            if self._result is not None and now < self._expires_at:
                return self._result

            started = self._clock()
            ok, reason = self._llm.probe(timeout_seconds=self._timeout)
            latency_ms = int((self._clock() - started) * 1000)
            self._result = ProbeResult(ok=ok, reason=reason or REASON_OK, latency_ms=latency_ms)
            ttl = self._ttl if ok else min(self._ttl, _MAX_FAILURE_TTL_SECONDS)
            self._expires_at = self._clock() + ttl
            return self._result

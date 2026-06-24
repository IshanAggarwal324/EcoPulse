"""A/B comparison framework for model versions (Module 4.2.6).

Routes a configurable fraction of forecast traffic to a challenger model
version while the champion (current LATEST) continues to serve the rest.
Predictions for both variants are logged to the ``modelcomparisons``
collection so they can be paired with later-arriving actuals for offline
scoring (MAPE delta, band coverage).

Design notes:
- Assignment is **deterministic per node** (SHA-256 of node_id) so the same
  node always sees the same variant. This avoids thrash and makes it possible
  to join predictions with that node's future actuals.
- Shadow logging (computing + storing the champion prediction when the
  challenger is served) is fire-and-forget so request latency is unaffected.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.config import Settings
from utils.database import modelcomparisons_collection

logger = logging.getLogger(__name__)

# Cap how many per-step predictions we store per comparison doc to keep docs
# bounded (horizon max is 90 days).
_MAX_STORED_STEPS = 90


def _serialize_predictions(predictions) -> list[dict[str, Any]]:
    if not predictions:
        return []
    out: list[dict[str, Any]] = []
    for pred in list(predictions)[:_MAX_STORED_STEPS]:
        if hasattr(pred, "model_dump"):
            out.append(pred.model_dump(mode="json"))
        elif isinstance(pred, dict):
            out.append(pred)
    return out


class ABTestService:
    def __init__(self, settings: Settings):
        self._settings = settings

    @property
    def enabled(self) -> bool:
        return bool(
            self._settings.ab_enabled
            and self._settings.ab_challenger_version
            and self._settings.ab_traffic_pct > 0
        )

    @property
    def champion_version(self) -> Optional[str]:
        return self._settings.ab_champion_version or None

    @property
    def challenger_version(self) -> Optional[str]:
        return self._settings.ab_challenger_version or None

    def resolve_assignment(self, node_id: Optional[str]) -> Optional[str]:
        """Return the challenger version for routed traffic, else ``None``.

        ``None`` means "serve champion (current LATEST)". The routing decision
        is a stable hash of node_id so a given node is never split across
        variants mid-experiment.
        """
        if not self.enabled:
            return None
        pct = self._settings.ab_traffic_pct
        if pct <= 0:
            return None
        key = (node_id or "aggregate").encode("utf-8")
        bucket = (int(hashlib.sha256(key).hexdigest(), 16) % 10000) / 100.0
        return self._settings.ab_challenger_version if bucket < pct else None

    async def log_comparison(
        self,
        *,
        node_id: Optional[str],
        champion_version: Optional[str],
        challenger_version: str,
        champion_predictions,
        challenger_predictions,
    ) -> None:
        """Persist both variants' predictions. Failures are logged, never raised."""
        try:
            doc = {
                "node_id": node_id,
                "champion_version": champion_version,
                "challenger_version": challenger_version,
                "horizon": len(challenger_predictions) if challenger_predictions else 0,
                "champion": _serialize_predictions(champion_predictions),
                "challenger": _serialize_predictions(challenger_predictions),
                "actuals": None,
                "champion_mape": None,
                "challenger_mape": None,
                "created_at": datetime.now(timezone.utc),
                "reconciled": False,
            }
            await modelcomparisons_collection.insert_one(doc)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("A/B comparison log failed: %s", exc)


async def schedule_shadow_log(
    ab: "ABTestService",
    forecast_service,
    *,
    node_id: Optional[str],
    days_to_predict: int,
    use_dummy_data: bool,
    champion_version: Optional[str],
    challenger_version: str,
    challenger_predictions,
) -> None:
    """Background task: compute the champion prediction and log both variants.

    Swallows all errors — shadow logging must never affect the live response.
    """
    try:
        champion_predictions, _ctx = await forecast_service.predict(
            days_to_predict, use_dummy_data, node_id, None
        )
        await ab.log_comparison(
            node_id=node_id,
            champion_version=champion_version,
            challenger_version=challenger_version,
            champion_predictions=champion_predictions,
            challenger_predictions=challenger_predictions,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("A/B shadow logging failed: %s", exc)

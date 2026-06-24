"""Forecast drift monitoring (Module 4.2.8).

Compares recent *realised* forecast errors (from reconciled A/B comparison
records) against the model's training-time error distribution. When the
relative error increase exceeds a threshold the monitor flags a drift warning,
which the retrain scheduler (4.2.2) can use as a trigger.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from app.config import Settings
from models.metrics import aggregate_mape, _safe_mape  # type: ignore
from models.model_registry import get_latest, read_metadata
from utils.database import get_historical_data, modelcomparisons_collection

logger = logging.getLogger(__name__)

_MIN_DRIFT_SAMPLES = 5


@dataclass
class DriftReport:
    status: str  # "ok" | "warning" | "unknown"
    recent_mape: Optional[float]
    baseline_mape: Optional[float]
    relative_increase: Optional[float]
    threshold: float
    samples: int
    details: Dict[str, Any] = field(default_factory=dict)


def _pred_mapes_against_actuals(predictions: list[dict], actuals: dict) -> Optional[float]:
    """Average per-step MAPE for a variant's predictions vs realised actuals.

    ``actuals`` maps ISO date (YYYY-MM-DD) -> (generation, consumption).
    Returns None if there is no overlapping day to score.
    """
    gen_actual: list[float] = []
    gen_pred: list[float] = []
    cons_actual: list[float] = []
    cons_pred: list[float] = []
    import numpy as np

    for step in predictions:
        ts = step.get("timestamp")
        if not ts:
            continue
        day = str(ts)[:10]
        actual = actuals.get(day)
        if not actual:
            continue
        ag, ac = actual
        gen_actual.append(ag)
        cons_actual.append(ac)
        gen_pred.append(float(step.get("predicted_generation", 0.0)))
        cons_pred.append(float(step.get("predicted_consumption", 0.0)))

    if not gen_actual:
        return None
    ga = np.array(gen_actual)
    gp = np.array(gen_pred)
    ca = np.array(cons_actual)
    cp = np.array(cons_pred)
    return (_safe_mape(ga, gp) + _safe_mape(ca, cp)) / 2.0


class DriftMonitor:
    def __init__(self, settings: Settings):
        self._settings = settings

    async def check_drift(self) -> DriftReport:
        settings = self._settings
        latest = get_latest(_model_root(settings))
        baseline_mape: Optional[float] = None
        if latest:
            meta = read_metadata(
                registry_dir=settings.registry_dir,
                model_name=settings.registry_model_name,
                version=latest,
            )
            baseline_mape = aggregate_mape(meta.get("metrics", {}))

        window_start = datetime.now(timezone.utc) - timedelta(days=settings.drift_window_days)
        cursor = modelcomparisons_collection.find(
            {"reconciled": True, "champion_mape": {"$ne": None}, "created_at": {"$gte": window_start}},
            {"champion_mape": 1},
        )
        mapes: list[float] = []
        async for doc in cursor:
            m = doc.get("champion_mape")
            try:
                if m is not None:
                    mapes.append(float(m))
            except (TypeError, ValueError):
                continue

        if len(mapes) < _MIN_DRIFT_SAMPLES or baseline_mape is None or baseline_mape <= 0:
            return DriftReport(
                status="unknown",
                recent_mape=(sum(mapes) / len(mapes)) if mapes else None,
                baseline_mape=baseline_mape,
                relative_increase=None,
                threshold=settings.drift_mape_threshold,
                samples=len(mapes),
                details={"reason": "insufficient_reconciled_samples"},
            )

        recent_mape = sum(mapes) / len(mapes)
        relative_increase = (recent_mape - baseline_mape) / baseline_mape
        status = "warning" if relative_increase > settings.drift_mape_threshold else "ok"
        return DriftReport(
            status=status,
            recent_mape=recent_mape,
            baseline_mape=baseline_mape,
            relative_increase=relative_increase,
            threshold=settings.drift_mape_threshold,
            samples=len(mapes),
        )

    async def reconcile_actuals(self, *, max_docs: int = 200) -> int:
        """Backfill realised actuals + per-variant MAPE for recent comparisons.

        Only processes docs older than 1 day (so next-day actuals exist) and
        not yet reconciled. Returns the number of docs reconciled.
        """
        settings = self._settings
        cutoff = datetime.now(timezone.utc) - timedelta(days=1)
        cursor = (
            modelcomparisons_collection.find({"reconciled": {"$ne": True}, "created_at": {"$lt": cutoff}})
            .sort("created_at", -1)
            .limit(max_docs)
        )
        docs = await cursor.to_list(length=max_docs)
        if not docs:
            return 0

        reconciled = 0
        for doc in docs:
            node_id = doc.get("node_id")
            champion = doc.get("champion") or []
            challenger = doc.get("challenger") or []
            horizon = max(len(champion), len(challenger), 1)
            try:
                df = await get_historical_data(use_dummy=False, days=horizon + 5, node_id=node_id)
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("reconcile fetch failed for node=%s: %s", node_id, exc)
                continue
            if df is None or df.empty:
                continue
            actuals: dict[str, tuple[float, float]] = {}
            for day, row in df.iterrows():
                actuals[str(day.date())] = (float(row["generation"]), float(row["consumption"]))

            champ_mape = _pred_mapes_against_actuals(champion, actuals)
            chal_mape = _pred_mapes_against_actuals(challenger, actuals)
            if champ_mape is None and chal_mape is None:
                continue

            await modelcomparisons_collection.update_one(
                {"_id": doc["_id"]},
                {
                    "$set": {
                        "actuals": actuals,
                        "champion_mape": champ_mape,
                        "challenger_mape": chal_mape,
                        "reconciled": True,
                        "reconciled_at": datetime.now(timezone.utc),
                    }
                },
            )
            reconciled += 1
        return reconciled


def _model_root(settings: Settings) -> str:
    import os

    return os.path.join(settings.registry_dir, settings.registry_model_name)

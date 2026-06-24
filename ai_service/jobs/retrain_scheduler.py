"""Scheduled retraining pipeline (Module 4.2.2).

Flow:
  1. Gate on minimum data volume (>= N days, >= M nodes, > 0 readings).
  2. Train a candidate model on live data WITHOUT promoting it.
  3. Evaluate candidate vs current champion (holdout MAPE).
  4. Promote (set_latest) only if the candidate improves MAPE by at least the
     configured margin — unless ``force=True``.

Run as a CLI entrypoint from a cron / K8s CronJob / GitHub Action:
    python -m jobs.retrain_scheduler
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional

from app.config import Settings, get_settings
from models.metrics import aggregate_mape
from models.model_registry import get_latest, read_metadata, set_latest
from train import run_training
from utils.database import get_data_volume_summary

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@dataclass
class RetrainReport:
    trained_version: Optional[str]
    promoted: bool
    reason: str
    candidate_mape: Optional[float]
    current_mape: Optional[float]
    data_volume: Dict[str, Any]
    metrics: Dict[str, Any]


def _model_root(settings: Settings) -> str:
    return os.path.join(settings.registry_dir, settings.registry_model_name)


def _current_mape(settings: Settings) -> Optional[float]:
    latest = get_latest(_model_root(settings))
    if not latest:
        return None
    meta = read_metadata(
        registry_dir=settings.registry_dir,
        model_name=settings.registry_model_name,
        version=latest,
    )
    return aggregate_mape(meta.get("metrics", {}))


async def _data_volume_ok(settings: Settings) -> tuple[bool, dict]:
    vol = await get_data_volume_summary(days=settings.retrain_history_days)
    ok = (
        vol.get("date_span_days", 0) >= settings.retrain_min_days
        and vol.get("distinct_nodes", 0) >= settings.retrain_min_nodes
        and vol.get("total_readings", 0) > 0
    )
    return ok, vol


def _should_promote(
    *,
    candidate_mape: Optional[float],
    current_mape: Optional[float],
    improvement_margin: float,
    force: bool,
) -> bool:
    if force:
        return True
    if candidate_mape is None:
        return False
    if current_mape is None:
        return True  # first model / no baseline yet
    return candidate_mape <= current_mape - improvement_margin


async def run_retrain(
    *,
    settings: Optional[Settings] = None,
    force: bool = False,
) -> RetrainReport:
    settings = settings or get_settings()

    ok, vol = await _data_volume_ok(settings)
    if not ok and not force:
        logger.warning("Skipping retrain: data volume gate not met: %s", vol)
        return RetrainReport(
            trained_version=None,
            promoted=False,
            reason="data_volume_gate_failed",
            candidate_mape=None,
            current_mape=None,
            data_volume=vol,
            metrics={},
        )

    try:
        result = await run_training(
            use_dummy=False,
            days=settings.retrain_history_days,
            promote=False,
            settings=settings,
        )
    except Exception as exc:
        logger.error("Candidate training failed: %s", exc)
        return RetrainReport(
            trained_version=None,
            promoted=False,
            reason="training_failed",
            candidate_mape=None,
            current_mape=_current_mape(settings),
            data_volume=vol,
            metrics={},
        )

    candidate_mape = aggregate_mape(result.metrics)
    current_mape = _current_mape(settings)

    if _should_promote(
        candidate_mape=candidate_mape,
        current_mape=current_mape,
        improvement_margin=settings.retrain_mape_improvement,
        force=force,
    ):
        set_latest(_model_root(settings), result.version)
        logger.info(
            "Promoted %s (candidate_mape=%s current_mape=%s)",
            result.version,
            candidate_mape,
            current_mape,
        )
        return RetrainReport(
            trained_version=result.version,
            promoted=True,
            reason="promoted",
            candidate_mape=candidate_mape,
            current_mape=current_mape,
            data_volume=vol,
            metrics=result.metrics,
        )

    logger.info(
        "Candidate %s NOT promoted (candidate_mape=%s current_mape=%s)",
        result.version,
        candidate_mape,
        current_mape,
    )
    return RetrainReport(
        trained_version=result.version,
        promoted=False,
        reason="not_improved",
        candidate_mape=candidate_mape,
        current_mape=current_mape,
        data_volume=vol,
        metrics=result.metrics,
    )


async def _maybe_run_per_node(settings: Settings) -> None:
    """Module 4.3.4 — optional per-node batch step. Failures are isolated and
    never affect the global retrain outcome."""
    try:
        from train_node import run_per_node_training
        await run_per_node_training(settings=settings)
    except Exception as exc:  # pragma: no cover - best-effort, logged only
        logger.error("Per-node training batch failed: %s", exc)


async def main() -> None:
    settings = get_settings()
    force = os.getenv("ECOPULSE_RETRAIN_FORCE", "").lower() in ("1", "true", "yes")
    report = await run_retrain(force=force, settings=settings)
    # Module 4.3.4 — per-node batch runs as a best-effort step after the global
    # retrain. Its failures are isolated and never invalidate the report above.
    if settings.per_node_training_enabled:
        await _maybe_run_per_node(settings)
    print(asdict(report))  # noqa: T201 - CLI output for cron log scraping


if __name__ == "__main__":
    asyncio.run(main())

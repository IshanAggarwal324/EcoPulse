"""Per-node training loop (Module 4.3.4).

Trains a dedicated model per node that has sufficient history (>= N days) and
skips sparse nodes. Designed to be invoked as a batch step inside the retrain
pipeline (Module 4.2.2) or standalone as a CLI::

    python -m train_node            # train all eligible nodes
    python -m train_node --node <id>

Production guard rails:
- Eligible nodes are capped per run (``node_max_train_per_run``) to bound
  compute / memory when many nodes exist (DoS protection).
- Each node is trained in isolation: a single node failure is logged and
  skipped; it never aborts the whole batch.
- Horizon is validated against the configured allow-list.
- Nodes without enough samples to build even one (look_back + horizon) window
  are skipped.
- Per-node training always runs on live data; dummy data is rejected.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from app.config import Settings, get_settings
from models.forecasting import build_model, train_model
from models.metrics import aggregate_mape, evaluate_multi_horizon_holdout, evaluate_holdout
from models.node_model_registry import assert_safe_node_id, save_node_bundle
from models.preprocessing import (
    assert_valid_horizon,
    build_training_matrices,
)
from utils.database import get_historical_data, list_nodes_with_history

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@dataclass
class NodeTrainingResult:
    node_id: str
    status: str  # trained | skipped | failed
    version: Optional[str] = None
    horizon: Optional[int] = None
    n_rows: int = 0
    mape: Optional[float] = None
    reason: Optional[str] = None


@dataclass
class PerNodeReport:
    trained: int = 0
    skipped: int = 0
    failed: int = 0
    eligible: int = 0
    capped: bool = False
    horizon: int = 30
    results: List[NodeTrainingResult] = field(default_factory=list)


async def run_node_training(
    node_id: str,
    *,
    settings: Optional[Settings] = None,
    horizon: Optional[int] = None,
    promote: bool = True,
) -> NodeTrainingResult:
    """Train (and persist) a single per-node model."""
    settings = settings or get_settings()
    assert_safe_node_id(node_id)
    horizon = assert_valid_horizon(horizon or settings.default_horizon, settings.forecast_horizons)

    logger.info("Per-node training start: node=%s horizon=%s", node_id, horizon)

    # Production path is live-data only; per-node models never train on dummy data.
    df = await get_historical_data(use_dummy=False, days=settings.node_min_history_days + 30, node_id=node_id)
    if df.empty:
        logger.info("Node %s skipped: no data", node_id)
        return NodeTrainingResult(node_id=node_id, status="skipped", reason="no_data")

    look_back = settings.look_back_days
    try:
        matrices, scaler, preprocessing_meta = build_training_matrices(
            df, look_back=look_back,
            train_ratio=float(os.getenv("ECOPULSE_TRAIN_RATIO", "0.8")),
            val_ratio=float(os.getenv("ECOPULSE_VAL_RATIO", "0.1")),
            horizon=horizon,
        )
    except ValueError as exc:
        logger.info("Node %s skipped: %s", node_id, exc)
        return NodeTrainingResult(node_id=node_id, status="skipped", reason=str(exc))

    X_train, y_train = matrices["X_train"], matrices["y_train"]
    if len(X_train) == 0:
        logger.info("Node %s skipped: not enough windows", node_id)
        return NodeTrainingResult(node_id=node_id, status="skipped", reason="insufficient_windows",
                                  n_rows=int(len(df)))

    X_val, y_val = matrices["X_val"], matrices["y_val"]
    X_test, y_test = matrices["X_test"], matrices["y_test"]

    model = build_model((X_train.shape[1], X_train.shape[2]), horizon=horizon)
    epochs = int(os.getenv("ECOPULSE_EPOCHS", "20"))
    batch_size = int(os.getenv("ECOPULSE_BATCH_SIZE", "32"))
    model = train_model(
        model, X_train, y_train,
        X_val=X_val, y_val=y_val, epochs=epochs, batch_size=batch_size,
    )

    if horizon == 1:
        metrics = evaluate_holdout(model, X_test, y_test, scaler, alpha=settings.conformal_alpha)
    else:
        metrics = evaluate_multi_horizon_holdout(
            model, X_test, y_test, scaler, horizon=horizon, alpha=settings.conformal_alpha
        )

    version = save_node_bundle(
        node_id=node_id,
        model=model,
        scaler=scaler,
        preprocessing_meta=preprocessing_meta,
        training_meta={
            "epochs": epochs,
            "batch_size": batch_size,
            "data_source": "live",
            "scope": "per_node",
            "n_rows": int(len(df)),
        },
        metrics=metrics,
        registry_dir=settings.registry_dir,
        model_name=settings.registry_model_name,
        promote=promote,
    )

    mape = aggregate_mape(metrics)
    logger.info("Node %s trained: version=%s mape=%s", node_id, version, mape)
    return NodeTrainingResult(
        node_id=node_id, status="trained", version=version, horizon=horizon,
        n_rows=int(len(df)), mape=mape,
    )


async def run_per_node_training(
    *,
    settings: Optional[Settings] = None,
    horizon: Optional[int] = None,
    node_ids: Optional[List[str]] = None,
    promote: bool = True,
) -> PerNodeReport:
    """Train eligible per-node models in a bounded, fault-isolated batch."""
    settings = settings or get_settings()
    horizon = assert_valid_horizon(horizon or settings.default_horizon, settings.forecast_horizons)
    report = PerNodeReport(horizon=horizon)

    if node_ids is None:
        try:
            eligible = await list_nodes_with_history(min_days=settings.node_min_history_days)
        except Exception as exc:  # DB unreachable -> fail closed, no training.
            logger.error("Cannot enumerate nodes: %s", exc)
            return report
        candidates = [e["node_id"] for e in eligible]
    else:
        candidates = []
        for nid in node_ids:
            try:
                candidates.append(assert_safe_node_id(nid))
            except ValueError as exc:
                report.results.append(NodeTrainingResult(node_id=str(nid), status="failed", reason=str(exc)))
                report.failed += 1

    report.eligible = len(candidates)

    # DoS guard: cap nodes trained per run.
    if len(candidates) > settings.node_max_train_per_run:
        report.capped = True
        logger.warning(
            "Per-node batch capped from %d to %d nodes (node_max_train_per_run)",
            len(candidates), settings.node_max_train_per_run,
        )
        candidates = candidates[: settings.node_max_train_per_run]

    for node_id in candidates:
        try:
            result = await run_node_training(
                node_id, settings=settings, horizon=horizon, promote=promote
            )
        except Exception as exc:  # isolate per-node failures.
            logger.error("Node %s training failed: %s", node_id, exc)
            result = NodeTrainingResult(node_id=node_id, status="failed", reason=str(exc))

        report.results.append(result)
        if result.status == "trained":
            report.trained += 1
        elif result.status == "skipped":
            report.skipped += 1
        else:
            report.failed += 1

    logger.info(
        "Per-node batch done: trained=%d skipped=%d failed=%d eligible=%d capped=%s",
        report.trained, report.skipped, report.failed, report.eligible, report.capped,
    )
    return report


async def _main() -> None:
    parser = argparse.ArgumentParser(description="Train per-node forecast models (4.3.4)")
    parser.add_argument("--node", action="append", dest="node_ids", help="specific node id (repeatable)")
    parser.add_argument("--horizon", type=int, default=None, help="forecast horizon (default from settings)")
    parser.add_argument("--no-promote", action="store_true", help="train without promoting to LATEST")
    args = parser.parse_args()

    report = await run_per_node_training(
        horizon=args.horizon,
        node_ids=args.node_ids,
        promote=not args.no_promote,
    )
    print(asdict(report))  # noqa: T201 - CLI output for cron log scraping


if __name__ == "__main__":
    asyncio.run(_main())

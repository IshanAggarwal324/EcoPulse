"""Offline trainer for the meter anomaly detector (Module 4.1.8).

Mirrors train.py: env-driven, async, pulls historical readings, builds
features, fits an Isolation Forest, and registers a versioned bundle via
save_anomaly_bundle. Calibration params + the stable feature list are stored
in feature_config so inference uses the identical mapping.

Env knobs:
  ECOPULSE_ANOMALY_TRAIN_DAYS    history window (default 180)
  ANOMALY_CONTAMINATION          expected anomaly fraction (default 0.05)
  ANOMALY_FEATURE_WINDOW         rolling window for stats (default 7)
  ANOMALY_SCORE_THRESHOLD        score cutoff for is_anomaly (default 0.7)
  ANOMALY_ZSCORE_CAP             z/jump cutoff for reason codes (default 3.0)
  ECOPULSE_ANOMALY_MODEL_VERSION optional explicit version pin
  ECOPULSE_ANOMALY_USE_DUMMY     '1'/'true' to train on synthetic data
"""

import asyncio
import logging
import os

import numpy as np

from models.anomaly_detection import (
    DEFAULT_N_ESTIMATORS,
    DEFAULT_RANDOM_STATE,
    build_model,
    train_model,
)
from models.anomaly_preprocessing import FEATURE_COLUMNS, build_feature_frame
from models.model_registry import ANOMALY_MODEL_NAME, save_anomaly_bundle
from utils.database import get_historical_data

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes")


async def main() -> None:
    days = int(os.getenv("ECOPULSE_ANOMALY_TRAIN_DAYS", "180"))
    window = int(os.getenv("ANOMALY_FEATURE_WINDOW", "7"))
    contamination = float(os.getenv("ANOMALY_CONTAMINATION", "0.05"))
    threshold = float(os.getenv("ANOMALY_SCORE_THRESHOLD", "0.7"))
    zcap = float(os.getenv("ANOMALY_ZSCORE_CAP", "3.0"))
    use_dummy = _env_truthy("ECOPULSE_ANOMALY_USE_DUMMY")

    logger.info(
        "Training anomaly model (days=%s window=%s contamination=%s dummy=%s)",
        days, window, contamination, use_dummy,
    )

    # Train on the global aggregate (node_id=None) by default. Per-node models
    # can be trained by setting ECOPULSE_ANOMALY_TRAIN_NODE.
    node_id = os.getenv("ECOPULSE_ANOMALY_TRAIN_NODE") or None
    df = await get_historical_data(use_dummy=use_dummy, days=days, node_id=node_id)
    if df is None or len(df) < max(30, window * 3):
        raise SystemExit(
            f"Insufficient training data: got {0 if df is None else len(df)} rows "
            f"(need >= {max(30, window * 3)})"
        )

    frame = build_feature_frame(df, window=window)
    X = frame[FEATURE_COLUMNS].to_numpy(dtype=float)

    model = build_model(
        contamination=contamination,
        random_state=DEFAULT_RANDOM_STATE,
        n_estimators=int(os.getenv("ANOMALY_N_ESTIMATORS", str(DEFAULT_N_ESTIMATORS))),
    )
    calibration = train_model(model, X)

    feature_config = {
        "feature_columns": list(FEATURE_COLUMNS),
        "calibration": calibration,
        "threshold": threshold,
        "zscore_cap": zcap,
        "feature_window": window,
    }
    training_meta = {
        "rows": int(len(frame)),
        "days": days,
        "node_id": node_id,
        "contamination": contamination,
        "score_min": float(np.min(frame[FEATURE_COLUMNS].to_numpy(dtype=float))),
    }

    version = save_anomaly_bundle(
        model=model,
        feature_config=feature_config,
        training_meta=training_meta,
        model_name=ANOMALY_MODEL_NAME,
        version=os.getenv("ECOPULSE_ANOMALY_MODEL_VERSION") or None,
    )
    logger.info("Anomaly bundle saved: %s version=%s", ANOMALY_MODEL_NAME, version)


if __name__ == "__main__":
    asyncio.run(main())

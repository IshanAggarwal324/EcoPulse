import asyncio
import logging
import os
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional

from app.config import Settings, get_settings
from models.forecasting import build_model, train_model
from models.metrics import aggregate_mape, evaluate_holdout
from models.model_registry import save_bundle
from models.preprocessing import build_training_matrices
from utils.database import get_historical_data

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@dataclass
class TrainingResult:
    version: str
    promoted: bool
    data_source: str
    n_rows: int
    metrics: Dict[str, Any]


def _resolve_use_dummy(settings: Settings) -> bool:
    """Production path must train on live data; dummy is dev/test only."""
    requested = os.getenv("ECOPULSE_USE_DUMMY", "").lower() in ("1", "true", "yes")
    if os.getenv("NODE_ENV") == "production":
        if requested:
            logger.warning("ECOPULSE_USE_DUMMY ignored in production — training on live data")
        return False
    return requested


async def run_training(
    *,
    use_dummy: Optional[bool] = None,
    days: Optional[int] = None,
    promote: bool = True,
    settings: Optional[Settings] = None,
) -> TrainingResult:
    """Train, evaluate holdout, compute conformal margins, persist a bundle.

    ``promote=False`` writes a candidate version without updating LATEST, so the
    retrain scheduler can decide whether to promote it.
    """
    settings = settings or get_settings()
    if use_dummy is None:
        use_dummy = _resolve_use_dummy(settings)
    days = days or settings.retrain_history_days

    logger.info("Starting training (use_dummy=%s, days=%s, promote=%s)", use_dummy, days, promote)

    df = await get_historical_data(use_dummy=use_dummy, days=days)
    if df.empty:
        raise RuntimeError("No data available for training")

    look_back = settings.look_back_days
    matrices, scaler, preprocessing_meta = build_training_matrices(
        df,
        look_back=look_back,
        train_ratio=float(os.getenv("ECOPULSE_TRAIN_RATIO", "0.8")),
        val_ratio=float(os.getenv("ECOPULSE_VAL_RATIO", "0.1")),
    )
    X_train, y_train = matrices["X_train"], matrices["y_train"]
    X_val, y_val = matrices["X_val"], matrices["y_val"]
    X_test, y_test = matrices["X_test"], matrices["y_test"]

    if len(X_train) == 0:
        raise RuntimeError("Not enough data after preprocessing to build training windows")

    model = build_model((X_train.shape[1], X_train.shape[2]))
    epochs = int(os.getenv("ECOPULSE_EPOCHS", "20"))
    batch_size = int(os.getenv("ECOPULSE_BATCH_SIZE", "32"))
    model = train_model(
        model,
        X_train,
        y_train,
        X_val=X_val,
        y_val=y_val,
        epochs=epochs,
        batch_size=batch_size,
    )

    # Module 4.2.1 / 4.2.4 — holdout metrics + conformal uncertainty margins.
    metrics = evaluate_holdout(model, X_test, y_test, scaler, alpha=settings.conformal_alpha)
    if metrics.get("n_samples", 0) == 0:
        logger.warning("Holdout set empty — metrics/conformal bands unavailable; bands will fall back to heuristic at inference")

    data_source = "dummy" if use_dummy else "live"
    version = save_bundle(
        model=model,
        scaler=scaler,
        preprocessing_meta=preprocessing_meta,
        training_meta={
            "epochs": epochs,
            "batch_size": batch_size,
            "data_source": data_source,
            "n_rows": int(len(df)),
        },
        metrics=metrics,
        promote=promote,
        version=os.getenv("ECOPULSE_MODEL_VERSION") or None,
    )

    logger.info(
        "Training complete. version=%s promote=%s mape=%s",
        version,
        promote,
        aggregate_mape(metrics),
    )
    return TrainingResult(
        version=version,
        promoted=promote,
        data_source=data_source,
        n_rows=int(len(df)),
        metrics=metrics,
    )


async def main() -> None:
    result = await run_training(promote=True)
    logger.info("Saved version %s: %s", result.version, asdict(result))


if __name__ == "__main__":
    asyncio.run(main())

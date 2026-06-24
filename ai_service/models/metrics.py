"""Model evaluation metrics for the forecast pipeline (Module 4.2).

Pure functions only — no I/O — so they are trivially unit-testable and have no
TensorFlow dependency. ``evaluate_holdout`` computes holdout MAPE/RMSE plus
split-conformal uncertainty margins that are persisted in model metadata and
re-used at inference time to produce calibrated prediction bands.
"""
from __future__ import annotations

import math
from typing import Any, Dict, Optional

import numpy as np


_MAPE_EPS = 1e-6


def _safe_mape(actual: np.ndarray, predicted: np.ndarray) -> float:
    """Mean absolute percentage error, robust to near-zero denominators."""
    denom = np.where(np.abs(actual) < _MAPE_EPS, _MAPE_EPS, np.abs(actual))
    return float(np.mean(np.abs((actual - predicted) / denom)) * 100.0)


def _rmse(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(math.sqrt(float(np.mean((predicted - actual) ** 2))))


def _finite_quantile(values: np.ndarray, q: float) -> float:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return 0.0
    return float(np.quantile(finite, q))


def evaluate_holdout(
    model,
    X_test: np.ndarray,
    y_test: np.ndarray,
    scaler,
    *,
    alpha: float = 0.1,
) -> Dict[str, Any]:
    """Compute holdout MAPE/RMSE and split-conformal margins.

    Returns a metrics dict suitable for embedding in model metadata. When the
    holdout set is empty (or shapes mismatch), returns ``{"n_samples": 0}`` so
    callers fall back to heuristic bands instead of trusting undefined stats.
    """
    if (
        X_test is None
        or y_test is None
        or len(X_test) == 0
        or len(y_test) == 0
    ):
        return {"n_samples": 0}

    alpha = min(0.5, max(0.01, float(alpha)))
    preds_scaled = model.predict(X_test, verbose=0)
    preds = np.asarray(scaler.inverse_transform(preds_scaled), dtype=float)
    actuals = np.asarray(scaler.inverse_transform(y_test), dtype=float)

    if preds.shape != actuals.shape or preds.ndim != 2 or preds.shape[1] < 2:
        return {"n_samples": 0}

    preds = np.nan_to_num(preds, nan=0.0, posinf=0.0, neginf=0.0)
    actuals = np.nan_to_num(actuals, nan=0.0, posinf=0.0, neginf=0.0)

    gen_err = np.abs(preds[:, 0] - actuals[:, 0])
    cons_err = np.abs(preds[:, 1] - actuals[:, 1])
    q = 1.0 - alpha

    gen_margin = _finite_quantile(gen_err, q)
    cons_margin = _finite_quantile(cons_err, q)

    return {
        "n_samples": int(len(preds)),
        "alpha": alpha,
        "mape_generation": _safe_mape(actuals[:, 0], preds[:, 0]),
        "mape_consumption": _safe_mape(actuals[:, 1], preds[:, 1]),
        "rmse_generation": _rmse(actuals[:, 0], preds[:, 0]),
        "rmse_consumption": _rmse(actuals[:, 1], preds[:, 1]),
        "conformal": {
            "alpha": alpha,
            "generation_margin": gen_margin,
            "consumption_margin": cons_margin,
            "generation_coverage": float(np.mean(gen_err <= gen_margin)),
            "consumption_coverage": float(np.mean(cons_err <= cons_margin)),
        },
    }


def aggregate_mape(metrics: Optional[Dict[str, Any]]) -> Optional[float]:
    """Mean of generation + consumption MAPE, or None when unavailable."""
    if not metrics:
        return None
    g = metrics.get("mape_generation")
    c = metrics.get("mape_consumption")
    try:
        if g is None or c is None:
            return None
        return (float(g) + float(c)) / 2.0
    except (TypeError, ValueError):
        return None


def evaluate_multi_horizon_holdout(
    model,
    X_test: np.ndarray,
    y_test: np.ndarray,
    scaler,
    *,
    horizon: int,
    alpha: float = 0.1,
) -> Dict[str, Any]:
    """Holdout metrics for a multi-horizon (direct vector) model (Module 4.3).

    ``y_test`` is the flattened (samples, horizon*2) target. Returns per-step
    MAPE/RMSE plus per-step conformal margins so inference can build widening
    confidence bands. Falls back to ``{"n_samples": 0}`` on shape mismatch.
    """
    if horizon < 1:
        raise ValueError("horizon must be >= 1")
    if X_test is None or y_test is None or len(X_test) == 0 or len(y_test) == 0:
        return {"n_samples": 0}

    expected = horizon * 2
    preds_scaled = model.predict(X_test, verbose=0)
    preds_flat = np.asarray(preds_scaled, dtype=float)
    actual_flat = np.asarray(y_test, dtype=float)
    if preds_flat.ndim != 2 or preds_flat.shape[1] != expected or actual_flat.shape != preds_flat.shape:
        return {"n_samples": 0}

    n = preds_flat.shape[0]
    preds = preds_flat.reshape(n, horizon, 2)
    actual = actual_flat.reshape(n, horizon, 2)
    preds = np.nan_to_num(preds, nan=0.0, posinf=0.0, neginf=0.0)
    actual = np.nan_to_num(actual, nan=0.0, posinf=0.0, neginf=0.0)

    # Inverse-transform in (n*horizon, 2) batches (scaler is 2-column).
    preds_u = scaler.inverse_transform(preds.reshape(-1, 2)).reshape(n, horizon, 2)
    actual_u = scaler.inverse_transform(actual.reshape(-1, 2)).reshape(n, horizon, 2)
    preds_u = np.nan_to_num(preds_u, nan=0.0, posinf=0.0, neginf=0.0)
    actual_u = np.nan_to_num(actual_u, nan=0.0, posinf=0.0, neginf=0.0)

    alpha = min(0.5, max(0.01, float(alpha)))
    q = 1.0 - alpha
    steps = []
    for h in range(horizon):
        gen_err = np.abs(preds_u[:, h, 0] - actual_u[:, h, 0])
        cons_err = np.abs(preds_u[:, h, 1] - actual_u[:, h, 1])
        steps.append({
            "step": h + 1,
            "mape_generation": _safe_mape(actual_u[:, h, 0], preds_u[:, h, 0]),
            "mape_consumption": _safe_mape(actual_u[:, h, 1], preds_u[:, h, 1]),
            "rmse_generation": _rmse(actual_u[:, h, 0], preds_u[:, h, 0]),
            "rmse_consumption": _rmse(actual_u[:, h, 1], preds_u[:, h, 1]),
            "conformal": {
                "alpha": alpha,
                "generation_margin": _finite_quantile(gen_err, q),
                "consumption_margin": _finite_quantile(cons_err, q),
                "generation_coverage": float(np.mean(gen_err <= _finite_quantile(gen_err, q))),
                "consumption_coverage": float(np.mean(cons_err <= _finite_quantile(cons_err, q))),
            },
        })

    gen_all = np.mean([s["mape_generation"] for s in steps])
    cons_all = np.mean([s["mape_consumption"] for s in steps])
    return {
        "n_samples": int(n),
        "horizon": horizon,
        "alpha": alpha,
        "mape_generation": float(gen_all),
        "mape_consumption": float(cons_all),
        "per_step": steps,
    }

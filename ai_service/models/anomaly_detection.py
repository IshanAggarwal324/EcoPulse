"""Isolation-Forest-based anomaly scorer for meter readings (Module 4.1.2).

Unsupervised (no labels required), scikit-learn native, serialized via joblib.
Outputs per-reading ``anomaly_score`` (0-1, higher = more anomalous),
``is_anomaly`` (bool) and deterministic ``reason_codes`` for explainability.
"""

from typing import Any, Dict, List

import numpy as np
import pandas as pd

from models.anomaly_preprocessing import (
    feature_matrix,
    reason_codes_for_row,
)

DEFAULT_CONTAMINATION = 0.05
DEFAULT_RANDOM_STATE = 42
DEFAULT_N_ESTIMATORS = 200


def build_model(
    *,
    contamination: float = DEFAULT_CONTAMINATION,
    random_state: int = DEFAULT_RANDOM_STATE,
    n_estimators: int = DEFAULT_N_ESTIMATORS,
):
    """Construct an IsolationForest. sklearn is imported lazily so the service
    boots even if (the heavier) sklearn is absent."""
    from sklearn.ensemble import IsolationForest

    return IsolationForest(
        n_estimators=n_estimators,
        contamination=contamination,
        random_state=random_state,
        n_jobs=1,
    )


def train_model(model, X: np.ndarray) -> Dict[str, float]:
    """Fit the forest and return calibration params derived from the in-sample
    ``decision_function`` distribution (higher = more normal). Robust 1st/99th
    percentiles keep one pathological row from collapsing the scale."""
    model.fit(X)
    raw = model.decision_function(X)
    return _calibrate(raw)


def _calibrate(scores: np.ndarray) -> Dict[str, float]:
    if scores.size == 0:
        return {"lo": 0.0, "hi": 1.0}
    lo = float(np.percentile(scores, 1))
    hi = float(np.percentile(scores, 99))
    if hi - lo < 1e-9:
        hi = lo + 1.0
    return {"lo": lo, "hi": hi}


def _to_anomaly_score(decision: np.ndarray, calib: Dict[str, float]) -> np.ndarray:
    lo = float(calib.get("lo", 0.0))
    hi = float(calib.get("hi", 1.0))
    span = (hi - lo) or 1e-9
    normality = np.clip((decision - lo) / span, 0.0, 1.0)
    score = 1.0 - normality  # invert: high decision (normal) -> low anomaly score
    return np.round(score, 4)


def score(model, X: np.ndarray, calib: Dict[str, float]) -> np.ndarray:
    raw = model.decision_function(X)
    return _to_anomaly_score(raw, calib)


def _to_timestamp(value: Any):
    if isinstance(value, pd.Timestamp):
        return value.to_pydatetime()
    return value


def detect(
    model,
    frame: pd.DataFrame,
    *,
    calib: Dict[str, float],
    threshold: float = 0.7,
    zcap: float = 3.0,
    max_results: int = 500,
) -> List[Dict[str, Any]]:
    """Score every row of ``frame`` and return flagged anomalies, sorted by
    score descending and capped to ``max_results``. A reading is flagged when
    its ML score clears ``threshold`` OR a deterministic reason code fires
    (physical/statistical impossibility)."""
    X = feature_matrix(frame)
    if X.shape[0] == 0:
        return []

    scores = score(model, X, calib)
    gen = frame["generation"].values
    cons = frame["consumption"].values
    gen_z = frame["gen_zscore"].values
    cons_z = frame["cons_zscore"].values
    gen_jump = frame["gen_jump_ratio"].values
    cons_jump = frame["cons_jump_ratio"].values
    index = frame.index

    rows: List[Dict[str, Any]] = []
    n = min(len(index), len(scores))
    for i in range(n):
        s = float(scores[i])
        codes = reason_codes_for_row(
            float(gen[i]),
            float(cons[i]),
            float(gen_z[i]),
            float(cons_z[i]),
            float(gen_jump[i]),
            float(cons_jump[i]),
            zcap=zcap,
        )
        is_anom = bool(s >= threshold) or bool(codes)
        rows.append(
            {
                "timestamp": _to_timestamp(index[i]),
                "generation": round(float(gen[i]), 4),
                "consumption": round(float(cons[i]), 4),
                "anomaly_score": s,
                "is_anomaly": is_anom,
                "reason_codes": codes,
            }
        )

    rows.sort(key=lambda r: r["anomaly_score"], reverse=True)
    flagged = [r for r in rows if r["is_anomaly"]]
    return flagged[:max_results]

"""Feature engineering for meter-readings anomaly detection (Module 4.1.1).

Builds sliding-window statistical features from the daily generation/consumption
frame produced by ``utils.database.get_historical_data``. Pure pandas/numpy — no
TensorFlow, no MongoDB — so it is safe to unit-test in isolation.
"""

from typing import List

import numpy as np
import pandas as pd

DEFAULT_WINDOW = 7
_EPS = 1e-9
_CLIP = 50.0  # cap extreme z/delta ratios so one bad row can't poison the tree

REQUIRED_INPUT_COLUMNS = ["generation", "consumption"]

# Contract-stable feature order. The exact sequence is persisted in the trained
# bundle's feature_config, and MUST be identical at train and inference time.
FEATURE_COLUMNS: List[str] = [
    "gen_dod",
    "cons_dod",
    "gen_zscore",
    "cons_zscore",
    "gen_roll_std",
    "cons_roll_std",
    "net",
    "net_zscore",
    "gen_jump_ratio",
    "cons_jump_ratio",
]


def _validate_frame(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=REQUIRED_INPUT_COLUMNS)
    missing = [c for c in REQUIRED_INPUT_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Input frame missing required columns: {missing}")
    out = df.copy()
    for c in REQUIRED_INPUT_COLUMNS:
        out[c] = pd.to_numeric(out[c], errors="coerce")
    out = out.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return out


def _safe_pct(series: pd.Series) -> pd.Series:
    return (
        series.pct_change()
        .replace([np.inf, -np.inf], np.nan)
        .fillna(0.0)
        .clip(-_CLIP, _CLIP)
    )


def _rolling_std(series: pd.Series, window: int) -> pd.Series:
    std = series.rolling(window, min_periods=1).std(ddof=0)
    return std.replace(0.0, np.nan).fillna(_EPS).clip(lower=_EPS)


def build_feature_frame(df: pd.DataFrame, window: int = DEFAULT_WINDOW) -> pd.DataFrame:
    """Return a frame containing raw generation/consumption plus engineered
    feature columns. Safe for empty/short input (returns empty frame)."""
    window = max(2, int(window or DEFAULT_WINDOW))
    base = _validate_frame(df)
    if base.empty:
        return base

    gen = base["generation"]
    cons = base["consumption"]

    out = pd.DataFrame(index=base.index)
    out["generation"] = gen.values
    out["consumption"] = cons.values

    out["gen_dod"] = _safe_pct(gen).values
    out["cons_dod"] = _safe_pct(cons).values

    gen_mean = gen.rolling(window, min_periods=1).mean()
    cons_mean = cons.rolling(window, min_periods=1).mean()
    gen_std = _rolling_std(gen, window)
    cons_std = _rolling_std(cons, window)

    out["gen_zscore"] = ((gen - gen_mean) / gen_std).clip(-_CLIP, _CLIP).fillna(0.0).values
    out["cons_zscore"] = ((cons - cons_mean) / cons_std).clip(-_CLIP, _CLIP).fillna(0.0).values
    out["gen_roll_std"] = gen_std.replace(_EPS, 0.0).values
    out["cons_roll_std"] = cons_std.replace(_EPS, 0.0).values

    net = cons - gen
    net_mean = net.rolling(window, min_periods=1).mean()
    net_std = _rolling_std(net, window)
    out["net"] = net.values
    out["net_zscore"] = ((net - net_mean) / net_std).clip(-_CLIP, _CLIP).fillna(0.0).values

    gen_abs_diff = gen.diff().abs().fillna(0.0)
    cons_abs_diff = cons.diff().abs().fillna(0.0)
    out["gen_jump_ratio"] = (gen_abs_diff / gen_std).clip(0, 1000.0).values
    out["cons_jump_ratio"] = (cons_abs_diff / cons_std).clip(0, 1000.0).values

    return out.replace([np.inf, -np.inf], np.nan).fillna(0.0)


def feature_matrix(frame: pd.DataFrame) -> np.ndarray:
    """Return only the model-facing feature columns as a float ndarray."""
    cols = [c for c in FEATURE_COLUMNS if c in frame.columns]
    if not cols:
        return np.empty((0, len(FEATURE_COLUMNS)), dtype=float)
    return frame[cols].to_numpy(dtype=float)


def reason_codes_for_row(
    generation: float,
    consumption: float,
    gen_zscore: float,
    cons_zscore: float,
    gen_jump_ratio: float,
    cons_jump_ratio: float,
    *,
    zcap: float = 3.0,
) -> List[str]:
    """Deterministic, explainable reason codes for a single reading. These
    complement the unsupervised ML score so alerts are actionable."""
    codes: List[str] = []
    if generation < -_EPS:
        codes.append("negative_generation")
    if consumption < -_EPS:
        codes.append("negative_consumption")
    if gen_jump_ratio > zcap:
        codes.append("generation_jump")
    if cons_jump_ratio > zcap:
        codes.append("consumption_jump")
    if cons_zscore > zcap:
        codes.append("consumption_spike")
    if gen_zscore > zcap:
        codes.append("generation_spike")
    if gen_zscore < -zcap:
        codes.append("generation_drop")
    if cons_zscore < -zcap:
        codes.append("consumption_drop")
    return codes

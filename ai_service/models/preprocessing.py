import pandas as pd
import numpy as np
from sklearn.preprocessing import MinMaxScaler
from typing import Tuple, Optional, Sequence, Dict, Any


def _ensure_daily_index(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=["generation", "consumption"])

    out = df.copy()
    if not isinstance(out.index, pd.DatetimeIndex):
        if "timestamp" in out.columns:
            out["timestamp"] = pd.to_datetime(out["timestamp"], errors="coerce")
            out = out.set_index("timestamp")
        else:
            out.index = pd.to_datetime(out.index, errors="coerce")

    out = out.sort_index()

    # Standardize expected columns
    if "generation" not in out.columns and "energyGenerated" in out.columns:
        out["generation"] = out["energyGenerated"]
    if "consumption" not in out.columns and "energyConsumed" in out.columns:
        out["consumption"] = out["energyConsumed"]

    out = out[["generation", "consumption"]].astype("float64")

    # Normalize timestamps to date (midnight) to avoid reindex dropping all rows
    out.index = out.index.tz_localize(None)
    out.index = out.index.normalize()

    # If multiple rows map to same day, aggregate to daily totals
    if out.index.has_duplicates:
        out = out.groupby(out.index).sum()

    # Make the series strictly daily and fill gaps
    full_idx = pd.date_range(out.index.min(), out.index.max(), freq="D")
    out = out.reindex(full_idx)
    out.index.name = "timestamp"

    # Fill missing values conservatively: forward-fill then back-fill
    out = out.ffill().bfill()

    # Clip negatives (can happen with noisy/dummy data or ingestion bugs)
    out["generation"] = out["generation"].clip(lower=0.0)
    out["consumption"] = out["consumption"].clip(lower=0.0)
    return out


def time_split(
    df: pd.DataFrame,
    train_ratio: float = 0.8,
    val_ratio: float = 0.1,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """
    Chronological split to avoid leakage.
    """
    if train_ratio <= 0 or train_ratio >= 1:
        raise ValueError("train_ratio must be in (0, 1)")
    if val_ratio < 0 or (train_ratio + val_ratio) >= 1:
        raise ValueError("val_ratio must be >= 0 and train_ratio + val_ratio < 1")

    n = len(df)
    if n < 10:
        # Too small to be meaningful; keep everything as train
        return df, df.iloc[:0], df.iloc[:0]

    train_end = int(n * train_ratio)
    val_end = int(n * (train_ratio + val_ratio))
    train_df = df.iloc[:train_end]
    val_df = df.iloc[train_end:val_end]
    test_df = df.iloc[val_end:]
    return train_df, val_df, test_df


def make_supervised(
    scaled_values: np.ndarray,
    look_back: int,
    horizon: int = 1,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Converts scaled time-series to supervised windows (Module 4.3.1).

    X: (samples, look_back, features)
    y for horizon == 1: (samples, features)        # backward compatible
    y for horizon  > 1: (samples, horizon*features)  # flattened vector target

    Each window predicts the next ``horizon`` steps directly (no recursion).
    """
    if look_back <= 0:
        raise ValueError("look_back must be > 0")
    if horizon < 1:
        raise ValueError("horizon must be >= 1")

    n_features = scaled_values.shape[1]
    X, y = [], []
    for i in range(len(scaled_values) - look_back - horizon + 1):
        X.append(scaled_values[i:(i + look_back), :])
        window = scaled_values[(i + look_back):(i + look_back + horizon), :]
        if horizon == 1:
            y.append(window[0, :])
        else:
            y.append(window.reshape(-1))
    return np.array(X), np.array(y)


def preprocess_data(
    df: pd.DataFrame,
    look_back: int = 30,
    *,
    scaler: Optional[MinMaxScaler] = None,
    fit_scaler: bool = True,
    horizon: int = 1,
) -> Tuple[np.ndarray, np.ndarray, MinMaxScaler]:
    """
    Preprocesses the dataframe for LSTM training.
    - Ensures daily, gap-free index
    - Fills missing values
    - Scales (fit on provided data if fit_scaler=True)
    """
    clean = _ensure_daily_index(df)
    if clean.empty:
        y_cols = 2 if horizon == 1 else horizon * 2
        return np.empty((0, look_back, 2)), np.empty((0, y_cols)), MinMaxScaler(feature_range=(0, 1))

    used_scaler = scaler or MinMaxScaler(feature_range=(0, 1))
    if fit_scaler:
        scaled_data = used_scaler.fit_transform(clean.values)
    else:
        scaled_data = used_scaler.transform(clean.values)

    X, y = make_supervised(scaled_data, look_back=look_back, horizon=horizon)
    return X, y, used_scaler


def assert_valid_horizon(horizon: int, allowed: Sequence[int] = (1, 7, 14, 30)) -> int:
    """Validate that ``horizon`` is in the allow-list (guards against DoS via
    arbitrarily large output dimensions in Dense(horizon*2))."""
    try:
        h = int(horizon)
    except (TypeError, ValueError):
        raise ValueError(f"horizon must be an integer, got {horizon!r}")
    if h not in allowed:
        raise ValueError(f"horizon {h} not allowed; must be one of {sorted(allowed)}")
    return h


def prepare_for_prediction(
    df: pd.DataFrame,
    scaler: MinMaxScaler,
    look_back: int = 30,
) -> np.ndarray:
    """
    Prepares the last `look_back` days for prediction.
    """
    clean = _ensure_daily_index(df)
    last_data = clean.tail(look_back).values
    scaled_last_data = scaler.transform(last_data)
    return np.array([scaled_last_data])


def build_training_matrices(
    df: pd.DataFrame,
    look_back: int = 30,
    train_ratio: float = 0.8,
    val_ratio: float = 0.1,
    horizon: int = 1,
) -> Tuple[Dict[str, np.ndarray], MinMaxScaler, Dict[str, Any]]:
    """
    Leakage-safe preprocessing for model training.
    Returns:
      - matrices: {X_train, y_train, X_val, y_val, X_test, y_test}
      - scaler: fitted only on training slice
      - meta: details to persist alongside the model
    """
    if horizon < 1:
        raise ValueError("horizon must be >= 1")
    clean = _ensure_daily_index(df)
    train_df, val_df, test_df = time_split(clean, train_ratio=train_ratio, val_ratio=val_ratio)

    scaler = MinMaxScaler(feature_range=(0, 1))
    train_scaled = scaler.fit_transform(train_df.values)
    val_scaled = scaler.transform(val_df.values) if not val_df.empty else np.empty((0, 2))
    test_scaled = scaler.transform(test_df.values) if not test_df.empty else np.empty((0, 2))

    y_cols = 2 if horizon == 1 else horizon * 2
    X_train, y_train = make_supervised(train_scaled, look_back=look_back, horizon=horizon)
    X_val, y_val = (np.empty((0, look_back, 2)), np.empty((0, y_cols))) if val_df.empty else make_supervised(val_scaled, look_back=look_back, horizon=horizon)
    X_test, y_test = (np.empty((0, look_back, 2)), np.empty((0, y_cols))) if test_df.empty else make_supervised(test_scaled, look_back=look_back, horizon=horizon)

    meta = {
        "look_back": look_back,
        "horizon": horizon,
        "features": ["generation", "consumption"],
        "train_ratio": train_ratio,
        "val_ratio": val_ratio,
        "n_rows": int(len(clean)),
        "train_rows": int(len(train_df)),
        "val_rows": int(len(val_df)),
        "test_rows": int(len(test_df)),
        "start": str(clean.index.min()) if len(clean) else None,
        "end": str(clean.index.max()) if len(clean) else None,
        "freq": "D",
    }

    return (
        {
            "X_train": X_train,
            "y_train": y_train,
            "X_val": X_val,
            "y_val": y_val,
            "X_test": X_test,
            "y_test": y_test,
        },
        scaler,
        meta,
    )

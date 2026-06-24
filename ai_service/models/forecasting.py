import numpy as np
from typing import Any

def _keras():
    """
    Lazy import so the service can start even when TensorFlow isn't available
    (e.g. unsupported Python versions).
    """
    try:
        from tensorflow.keras.models import Sequential  # type: ignore
        from tensorflow.keras.layers import LSTM, Dense, Dropout  # type: ignore
        return Sequential, LSTM, Dense, Dropout
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "TensorFlow/Keras is not available in this Python environment. "
            "Install a supported TensorFlow build (often requires Python 3.10–3.12) "
            "or run the AI service in a compatible environment."
        ) from e


def build_model(input_shape: tuple, horizon: int = 1) -> Any:
    """
    Builds the LSTM forecasting model (Module 4.3.2).

    For horizon == 1 the output is Dense(2) (generation, consumption).
    For horizon  > 1 the output is Dense(horizon*2): a flattened vector of
    generation+consumption for each of the next ``horizon`` steps, predicted in
    a single forward pass (no recursive roll-forward).
    """
    if horizon < 1:
        raise ValueError("horizon must be >= 1")
    Sequential, LSTM, Dense, Dropout = _keras()
    model = Sequential()
    model.add(LSTM(50, return_sequences=True, input_shape=input_shape))
    model.add(Dropout(0.2))
    model.add(LSTM(50, return_sequences=False))
    model.add(Dropout(0.2))
    model.add(Dense(horizon * 2))  # gen + consumption per forecast step

    model.compile(optimizer='adam', loss='mse')
    return model

def train_model(
    model,
    X: np.ndarray,
    y: np.ndarray,
    *,
    X_val: np.ndarray | None = None,
    y_val: np.ndarray | None = None,
    epochs: int = 10,
    batch_size: int = 32,
):
    """
    Trains the LSTM model.
    """
    validation_data = None
    if X_val is not None and y_val is not None and len(X_val) > 0:
        validation_data = (X_val, y_val)

    model.fit(
        X,
        y,
        epochs=epochs,
        batch_size=batch_size,
        validation_data=validation_data,
        verbose=0,
        shuffle=False,  # important for time-series
    )
    return model

def predict_future(model, current_sequence: np.ndarray, days_to_predict: int, scaler) -> np.ndarray:
    """
    Predicts future values recursively.
    """
    predictions = []
    current_input = current_sequence.copy()
    
    for _ in range(days_to_predict):
        # Predict the next day
        next_pred = model.predict(current_input, verbose=0)
        predictions.append(next_pred[0])
        
        # Update the sequence by removing the oldest and appending the prediction
        # current_input shape is (1, look_back, features)
        next_pred_reshaped = np.reshape(next_pred, (1, 1, 2))
        current_input = np.append(current_input[:, 1:, :], next_pred_reshaped, axis=1)
        
    # Inverse transform predictions
    predictions = np.array(predictions)
    predictions_unscaled = scaler.inverse_transform(predictions)
    # Sanitize: clip negatives and replace non-finite values (production guard)
    predictions_unscaled = np.nan_to_num(predictions_unscaled, nan=0.0, posinf=0.0, neginf=0.0)
    return np.clip(predictions_unscaled, 0.0, None)


def predict_multi_horizon(
    model,
    current_sequence: np.ndarray,
    horizon: int,
    scaler,
) -> np.ndarray:
    """
    Single forward pass producing the next ``horizon`` steps (Module 4.3.2).

    Replaces the recursive ``predict_future`` roll-forward for multi-horizon
    models. Returns an array of shape (horizon, 2) in the original (unscaled)
    units of [generation, consumption] per step.

    Output is sanitized (non-finite -> 0, negatives clipped to 0) because
    forecast values feed the pricing engine and must never be NaN/negative.
    """
    if horizon < 1:
        raise ValueError("horizon must be >= 1")
    raw = model.predict(current_sequence, verbose=0)          # (1, horizon*2)
    flat = np.asarray(raw[0], dtype=float)                    # (horizon*2,)
    expected = horizon * 2
    if flat.shape[0] != expected:
        raise ValueError(
            f"model output width {flat.shape[0]} != horizon*2 ({expected}); "
            "model was likely trained with a different horizon"
        )
    steps = flat.reshape(horizon, 2)                          # (horizon, 2)
    unscaled = scaler.inverse_transform(steps)
    unscaled = np.nan_to_num(unscaled, nan=0.0, posinf=0.0, neginf=0.0)
    return np.clip(unscaled, 0.0, None)

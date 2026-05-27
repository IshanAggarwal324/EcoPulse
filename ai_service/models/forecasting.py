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


def build_model(input_shape: tuple) -> Any:
    """
    Builds the LSTM forecasting model.
    """
    Sequential, LSTM, Dense, Dropout = _keras()
    model = Sequential()
    model.add(LSTM(50, return_sequences=True, input_shape=input_shape))
    model.add(Dropout(0.2))
    model.add(LSTM(50, return_sequences=False))
    model.add(Dropout(0.2))
    model.add(Dense(2)) # Predicting 2 values: generation and consumption
    
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
    return predictions_unscaled

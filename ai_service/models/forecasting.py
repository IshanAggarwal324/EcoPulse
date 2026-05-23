import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout
import numpy as np

def build_model(input_shape: tuple) -> Sequential:
    """
    Builds the LSTM forecasting model.
    """
    model = Sequential()
    model.add(LSTM(50, return_sequences=True, input_shape=input_shape))
    model.add(Dropout(0.2))
    model.add(LSTM(50, return_sequences=False))
    model.add(Dropout(0.2))
    model.add(Dense(2)) # Predicting 2 values: generation and consumption
    
    model.compile(optimizer='adam', loss='mse')
    return model

def train_model(model: Sequential, X: np.ndarray, y: np.ndarray, epochs: int = 10, batch_size: int = 32):
    """
    Trains the LSTM model.
    """
    model.fit(X, y, epochs=epochs, batch_size=batch_size, validation_split=0.1, verbose=0)
    return model

def predict_future(model: Sequential, current_sequence: np.ndarray, days_to_predict: int, scaler) -> np.ndarray:
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

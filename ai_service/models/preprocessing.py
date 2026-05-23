import pandas as pd
import numpy as np
from sklearn.preprocessing import MinMaxScaler
from typing import Tuple

def preprocess_data(df: pd.DataFrame, look_back: int = 30) -> Tuple[np.ndarray, np.ndarray, MinMaxScaler]:
    """
    Preprocesses the dataframe for LSTM training.
    """
    scaler = MinMaxScaler(feature_range=(0, 1))
    scaled_data = scaler.fit_transform(df.values)
    
    X, y = [], []
    for i in range(len(scaled_data) - look_back):
        X.append(scaled_data[i:(i + look_back), :])
        y.append(scaled_data[i + look_back, :])
        
    return np.array(X), np.array(y), scaler

def prepare_for_prediction(df: pd.DataFrame, scaler: MinMaxScaler, look_back: int = 30) -> np.ndarray:
    """
    Prepares the last `look_back` days for prediction.
    """
    last_data = df.tail(look_back).values
    scaled_last_data = scaler.transform(last_data)
    return np.array([scaled_last_data])

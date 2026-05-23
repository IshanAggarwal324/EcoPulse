from fastapi import APIRouter, HTTPException
from typing import List
from datetime import datetime, timedelta
import pandas as pd
import logging

from app.schemas import ForecastRequest, ForecastResponse, ForecastResult
from utils.database import get_historical_data
from models.preprocessing import preprocess_data, prepare_for_prediction
from models.forecasting import build_model, train_model, predict_future

router = APIRouter(prefix="/forecast", tags=["Forecast"])
logger = logging.getLogger(__name__)

# Global variables to hold the trained model and scaler in memory
trained_model = None
data_scaler = None

@router.post("/", response_model=ForecastResponse)
async def get_forecast(request: ForecastRequest):
    global trained_model, data_scaler
    try:
        # 1. Load Data
        logger.info(f"Loading data (dummy={request.use_dummy_data})")
        df = get_historical_data(use_dummy=request.use_dummy_data, days=365)
        
        # 2. Train model if not already trained (for demonstration purposes, training on the fly)
        # In a real scenario, training should be done offline or periodically in a background task
        if trained_model is None or data_scaler is None:
            logger.info("Training new LSTM model...")
            look_back = 30
            X, y, scaler = preprocess_data(df, look_back=look_back)
            data_scaler = scaler
            
            model = build_model((X.shape[1], X.shape[2]))
            trained_model = train_model(model, X, y, epochs=5) # Kept small for quick response
            logger.info("Model training complete.")
        
        # 3. Prepare latest data for prediction
        look_back = 30
        current_sequence = prepare_for_prediction(df, data_scaler, look_back=look_back)
        
        # 4. Predict
        logger.info(f"Predicting for {request.days_to_predict} days")
        predictions = predict_future(trained_model, current_sequence, request.days_to_predict, data_scaler)
        
        # 5. Format output
        results = []
        last_date = df.index[-1]
        for i, pred in enumerate(predictions):
            pred_date = last_date + timedelta(days=i+1)
            results.append(ForecastResult(
                timestamp=pred_date,
                predicted_generation=float(pred[0]),
                predicted_consumption=float(pred[1])
            ))
            
        return ForecastResponse(
            predictions=results,
            model_status="Model used from memory" if trained_model else "Newly trained model"
        )
        
    except Exception as e:
        logger.error(f"Error generating forecast: {e}")
        raise HTTPException(status_code=500, detail=str(e))

from fastapi import APIRouter, HTTPException
from typing import List
from datetime import datetime, timedelta
import pandas as pd
import logging
import os
import joblib
from tensorflow.keras.models import load_model

from app.schemas import ForecastRequest, ForecastResponse, ForecastResult
from utils.database import get_historical_data
from models.preprocessing import prepare_for_prediction
from models.forecasting import predict_future

router = APIRouter(prefix="/forecast", tags=["Forecast"])
logger = logging.getLogger(__name__)

# Global variables to hold the trained model and scaler in memory
trained_model = None
data_scaler = None

MODEL_DIR = "models/saved"
MODEL_PATH = os.path.join(MODEL_DIR, "lstm_model.keras")
SCALER_PATH = os.path.join(MODEL_DIR, "scaler.save")

def load_artifacts():
    global trained_model, data_scaler
    if trained_model is None or data_scaler is None:
        try:
            logger.info("Loading pre-trained model and scaler from disk...")
            trained_model = load_model(MODEL_PATH)
            data_scaler = joblib.load(SCALER_PATH)
            logger.info("Successfully loaded artifacts.")
        except Exception as e:
            logger.error(f"Failed to load model artifacts: {e}")

@router.on_event("startup")
async def startup_event():
    # Load model on application startup
    load_artifacts()

@router.post("/", response_model=ForecastResponse)
async def get_forecast(request: ForecastRequest):
    global trained_model, data_scaler
    
    # Ensure artifacts are loaded
    if trained_model is None or data_scaler is None:
        load_artifacts()
        
    if trained_model is None or data_scaler is None:
        raise HTTPException(
            status_code=503, 
            detail="Model is not trained or unavailable. Please run train.py first."
        )

    try:
        # 1. Load latest Data for the prediction sequence
        # In production, we need the last `look_back` days to feed into the LSTM
        logger.info(f"Loading data sequence (dummy={request.use_dummy_data})")
        df = await get_historical_data(use_dummy=request.use_dummy_data, days=60) # Only need recent data
        
        # Fallback to dummy data if real data is empty
        if df.empty:
            logger.warning("No data in MongoDB, falling back to dummy data for forecast")
            df = await get_historical_data(use_dummy=True, days=60)

        # 2. Prepare latest data for prediction
        look_back = 30
        current_sequence = prepare_for_prediction(df, data_scaler, look_back=look_back)
        
        # 3. Predict
        logger.info(f"Predicting for {request.days_to_predict} days")
        predictions = predict_future(trained_model, current_sequence, request.days_to_predict, data_scaler)
        
        # 4. Format output
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
            model_status="Using pre-trained production model"
        )
        
    except Exception as e:
        logger.error(f"Error generating forecast: {e}")
        raise HTTPException(status_code=500, detail=str(e))

import asyncio
import os
import joblib
import logging
from utils.database import get_historical_data
from models.preprocessing import preprocess_data
from models.forecasting import build_model, train_model

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

MODEL_DIR = "models/saved"

async def main():
    logger.info("Starting offline training process...")
    
    # Ensure directory exists
    os.makedirs(MODEL_DIR, exist_ok=True)
    
    # 1. Load Data
    logger.info("Loading historical data...")
    # Change use_dummy to False in production to load from real MongoDB
    df = await get_historical_data(use_dummy=True, days=365)
    
    if df.empty:
        logger.error("No data available for training. Exiting.")
        return

    # 2. Preprocess Data
    logger.info("Preprocessing data...")
    look_back = 30
    X, y, scaler = preprocess_data(df, look_back=look_back)
    
    # 3. Build & Train Model
    logger.info("Building and training LSTM model...")
    model = build_model((X.shape[1], X.shape[2]))
    # For a real production scenario, increase epochs (e.g., 50 or 100)
    model = train_model(model, X, y, epochs=20, batch_size=32)
    
    # 4. Save Model & Scaler
    model_path = os.path.join(MODEL_DIR, "lstm_model.keras")
    scaler_path = os.path.join(MODEL_DIR, "scaler.save")
    
    logger.info(f"Saving model to {model_path}...")
    model.save(model_path)
    
    logger.info(f"Saving scaler to {scaler_path}...")
    joblib.dump(scaler, scaler_path)
    
    logger.info("Training complete and artifacts saved successfully.")

if __name__ == "__main__":
    asyncio.run(main())

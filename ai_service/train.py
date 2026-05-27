import asyncio
import os
import logging
from utils.database import get_historical_data
from models.preprocessing import build_training_matrices
from models.forecasting import build_model, train_model
from models.model_registry import save_bundle

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

async def main():
    logger.info("Starting offline training process...")

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
    matrices, scaler, preprocessing_meta = build_training_matrices(
        df,
        look_back=look_back,
        train_ratio=float(os.getenv("ECOPULSE_TRAIN_RATIO", "0.8")),
        val_ratio=float(os.getenv("ECOPULSE_VAL_RATIO", "0.1")),
    )
    X_train, y_train = matrices["X_train"], matrices["y_train"]
    X_val, y_val = matrices["X_val"], matrices["y_val"]
    
    # 3. Build & Train Model
    logger.info("Building and training LSTM model...")
    if len(X_train) == 0:
        logger.error("Not enough data after preprocessing to build training windows. Exiting.")
        return

    model = build_model((X_train.shape[1], X_train.shape[2]))
    # For a real production scenario, increase epochs (e.g., 50 or 100)
    epochs = int(os.getenv("ECOPULSE_EPOCHS", "20"))
    batch_size = int(os.getenv("ECOPULSE_BATCH_SIZE", "32"))
    model = train_model(
        model,
        X_train,
        y_train,
        X_val=X_val,
        y_val=y_val,
        epochs=epochs,
        batch_size=batch_size,
    )
    
    # 4. Save Model Bundle (persistence + versioning)
    logger.info("Saving model bundle (versioned registry)...")
    version = save_bundle(
        model=model,
        scaler=scaler,
        preprocessing_meta=preprocessing_meta,
        training_meta={
            "epochs": epochs,
            "batch_size": batch_size,
            "data_source": "dummy",
        },
        version=os.getenv("ECOPULSE_MODEL_VERSION") or None,
    )
    
    logger.info(f"Training complete. Saved version: {version}")

if __name__ == "__main__":
    asyncio.run(main())

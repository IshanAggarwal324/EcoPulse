from fastapi import APIRouter, HTTPException
from datetime import timedelta
import logging
import os
import joblib
from tensorflow.keras.models import load_model

from app.schemas import (
    ForecastRequest,
    ForecastResponse,
    ForecastResult,
    BatchForecastRequest,
    BatchForecastResponse,
    NodeForecast,
)
from utils.database import get_historical_data
from models.preprocessing import prepare_for_prediction
from models.forecasting import predict_future

router = APIRouter(prefix="/forecast", tags=["Forecast"])
logger = logging.getLogger(__name__)

trained_model = None
data_scaler = None

MODEL_DIR = "models/saved"
MODEL_PATH = os.path.join(MODEL_DIR, "lstm_model.keras")
SCALER_PATH = os.path.join(MODEL_DIR, "scaler.save")

LOOK_BACK = 30


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


def _format_predictions(predictions, last_date):
    results = []
    for i, pred in enumerate(predictions):
        pred_date = last_date + timedelta(days=i + 1)
        generation_value = float(pred[0])
        consumption_value = float(pred[1])

        confidence = max(0.55, 0.92 - (i * 0.05))
        uncertainty_pct = 1.0 - confidence

        generation_margin = abs(generation_value) * uncertainty_pct
        consumption_margin = abs(consumption_value) * uncertainty_pct

        results.append(
            ForecastResult(
                timestamp=pred_date,
                predicted_generation=generation_value,
                predicted_consumption=consumption_value,
                generation_lower=max(0.0, generation_value - generation_margin),
                generation_upper=generation_value + generation_margin,
                consumption_lower=max(0.0, consumption_value - consumption_margin),
                consumption_upper=consumption_value + consumption_margin,
                confidence=confidence,
            )
        )
    return results


async def _forecast_for_node(days_to_predict: int, use_dummy_data: bool, node_id=None):
    logger.info(
        "Loading data sequence (dummy=%s, node_id=%s)",
        use_dummy_data,
        node_id or "aggregate",
    )
    df = await get_historical_data(
        use_dummy=use_dummy_data, days=60, node_id=node_id
    )

    if df.empty:
        logger.warning(
            "No data for node %s, falling back to dummy data",
            node_id or "aggregate",
        )
        df = await get_historical_data(use_dummy=True, days=60, node_id=node_id)

    if df.empty:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient historical data for node {node_id or 'aggregate'}",
        )

    current_sequence = prepare_for_prediction(df, data_scaler, look_back=LOOK_BACK)
    predictions = predict_future(
        trained_model, current_sequence, days_to_predict, data_scaler
    )
    last_date = df.index[-1]
    return _format_predictions(predictions, last_date)


@router.on_event("startup")
async def startup_event():
    load_artifacts()


@router.post("/", response_model=ForecastResponse)
async def get_forecast(request: ForecastRequest):
    global trained_model, data_scaler

    if trained_model is None or data_scaler is None:
        load_artifacts()

    if trained_model is None or data_scaler is None:
        raise HTTPException(
            status_code=503,
            detail="Model is not trained or unavailable. Please run train.py first.",
        )

    try:
        logger.info("Predicting for %s days", request.days_to_predict)
        results = await _forecast_for_node(
            request.days_to_predict,
            request.use_dummy_data,
            request.node_id,
        )

        return ForecastResponse(
            predictions=results,
            model_status="Using pre-trained production model",
            node_id=request.node_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating forecast: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/batch", response_model=BatchForecastResponse)
async def get_batch_forecast(request: BatchForecastRequest):
    global trained_model, data_scaler

    if not request.node_ids:
        raise HTTPException(status_code=400, detail="node_ids must not be empty")

    if trained_model is None or data_scaler is None:
        load_artifacts()

    if trained_model is None or data_scaler is None:
        raise HTTPException(
            status_code=503,
            detail="Model is not trained or unavailable. Please run train.py first.",
        )

    forecasts = []
    errors = []

    for node_id in request.node_ids:
        try:
            results = await _forecast_for_node(
                request.days_to_predict,
                request.use_dummy_data,
                node_id,
            )
            forecasts.append(NodeForecast(node_id=node_id, predictions=results))
        except HTTPException as exc:
            errors.append({"node_id": node_id, "detail": exc.detail})
        except Exception as e:
            errors.append({"node_id": node_id, "detail": str(e)})

    if not forecasts:
        raise HTTPException(
            status_code=500,
            detail={"message": "No forecasts generated", "errors": errors},
        )

    response = BatchForecastResponse(
        forecasts=forecasts,
        model_status="Using pre-trained production model",
    )

    if errors:
        logger.warning("Batch forecast partial failures: %s", errors)

    return response

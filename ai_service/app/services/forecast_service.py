import logging
from datetime import timedelta
from typing import Optional

from app.config import Settings
from app.exceptions import BatchForecastError, InsufficientDataError
from app.schemas import ForecastResult, NodeForecast
from app.services.model_store import ModelStore
from models.forecasting import predict_future
from models.preprocessing import prepare_for_prediction
from utils.database import get_historical_data

logger = logging.getLogger(__name__)


class ForecastService:
    def __init__(self, model_store: ModelStore, settings: Settings):
        self._model_store = model_store
        self._settings = settings

    async def predict(
        self,
        days_to_predict: int,
        use_dummy_data: bool,
        node_id: Optional[str] = None,
    ) -> list[ForecastResult]:
        return await self._forecast_for_node(days_to_predict, use_dummy_data, node_id)

    async def predict_batch(
        self,
        node_ids: list[str],
        days_to_predict: int,
        use_dummy_data: bool,
    ) -> tuple[list[NodeForecast], list[dict]]:
        forecasts: list[NodeForecast] = []
        errors: list[dict] = []

        for node_id in node_ids:
            try:
                results = await self._forecast_for_node(
                    days_to_predict, use_dummy_data, node_id
                )
                forecasts.append(NodeForecast(node_id=node_id, predictions=results))
            except InsufficientDataError as exc:
                errors.append(
                    {"node_id": node_id, "error_code": exc.error_code, "detail": exc.message}
                )
            except Exception as exc:
                errors.append({"node_id": node_id, "error_code": "FORECAST_ERROR", "detail": str(exc)})

        if not forecasts:
            raise BatchForecastError(errors)

        if errors:
            logger.warning("Batch forecast partial failures: %s", errors)

        return forecasts, errors

    async def _forecast_for_node(
        self,
        days_to_predict: int,
        use_dummy_data: bool,
        node_id: Optional[str] = None,
    ) -> list[ForecastResult]:
        label = node_id or "aggregate"
        logger.info("Forecasting node=%s dummy=%s days=%s", label, use_dummy_data, days_to_predict)

        df = await get_historical_data(
            use_dummy=use_dummy_data,
            days=self._settings.history_days,
            node_id=node_id,
        )

        if df.empty:
            logger.warning("No data for %s, falling back to dummy data", label)
            df = await get_historical_data(
                use_dummy=True,
                days=self._settings.history_days,
                node_id=node_id,
            )

        if df.empty:
            raise InsufficientDataError(node_id=node_id)

        model = self._model_store.model
        scaler = self._model_store.scaler

        sequence = prepare_for_prediction(
            df, scaler, look_back=self._settings.look_back_days
        )
        raw_predictions = predict_future(
            model, sequence, days_to_predict, scaler
        )
        return self._format_predictions(raw_predictions, df.index[-1])

    @staticmethod
    def _format_predictions(predictions, last_date) -> list[ForecastResult]:
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

"""Forecast service — orchestrates model inference and batch requests."""
import asyncio
import logging
import math
import os
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from datetime import timedelta
from typing import Any, Optional

from app.config import Settings
from app.exceptions import AppError, BatchForecastError, InsufficientDataError, ModelUnavailableError
from app.schemas import ForecastResult, NodeForecast
from app.services.model_store import ModelStore
from models.forecasting import predict_future, predict_multi_horizon
from models.node_model_registry import assert_safe_node_id, load_node_bundle
from models.preprocessing import prepare_for_prediction
from utils.database import get_historical_data

logger = logging.getLogger(__name__)

BATCH_CONCURRENCY = max(1, int(os.getenv("FORECAST_BATCH_CONCURRENCY", "5")))
# Bounded in-memory cache for per-node models (avoids re-deserializing Keras
# artifacts on every request). Capped to bound memory under many-node tenants.
NODE_MODEL_CACHE_SIZE = max(1, int(os.getenv("FORECAST_NODE_MODEL_CACHE_SIZE", "32")))


@dataclass
class ForecastContext:
    """Metadata about which model produced a forecast (Module 4.3.5)."""
    scope: str          # "global" | "per_node"
    version: Optional[str] = None
    horizon: Optional[int] = None


class ForecastService:
    def __init__(self, model_store: ModelStore, settings: Settings):
        self._model_store = model_store
        self._settings = settings
        # LRU cache of per-node models: node_id -> (model, scaler, metadata, scope)
        self._node_cache: "OrderedDict[str, tuple]" = OrderedDict()
        self._node_cache_lock = asyncio.Lock()

    @property
    def allow_model_free_dummy(self) -> bool:
        return self._settings.allow_model_free_dummy

    async def _load_node_model(self, node_id: str) -> tuple:
        """Load (and cache) a per-node model, with global fallback (Module 4.3.5).

        ``node_id`` is validated against the registry's path-safe pattern before
        it is ever used on the filesystem; invalid ids raise AppError(400).
        """
        try:
            assert_safe_node_id(node_id)
        except ValueError as exc:
            raise AppError(
                f"Invalid node_id for per-node model: {exc}",
                status_code=400,
                error_code="INVALID_NODE_ID",
            ) from exc

        async with self._node_cache_lock:
            cached = self._node_cache.get(node_id)
            if cached is not None:
                self._node_cache.move_to_end(node_id)
                return cached

        # load_node_bundle resolves per-node then falls back to the global model.
        model, scaler, metadata, scope = load_node_bundle(
            node_id=node_id,
            registry_dir=self._settings.registry_dir,
            model_name=self._settings.registry_model_name,
        )

        # Only cache genuine per-node artifacts. Global fallback models are held
        # by ModelStore; caching them here would duplicate large objects in RAM.
        if scope == "per_node":
            async with self._node_cache_lock:
                self._node_cache[node_id] = (model, scaler, metadata, scope)
                self._node_cache.move_to_end(node_id)
                while len(self._node_cache) > NODE_MODEL_CACHE_SIZE:
                    self._node_cache.popitem(last=False)
        return model, scaler, metadata, scope

    async def predict(
        self,
        days_to_predict: int,
        use_dummy_data: bool,
        node_id: Optional[str] = None,
        model_version: Optional[str] = None,
        horizon: Optional[int] = None,
        model_scope: Optional[str] = None,
    ) -> tuple[list[ForecastResult], ForecastContext]:
        return await self._forecast_for_node(
            days_to_predict, use_dummy_data, node_id, model_version, horizon, model_scope
        )

    async def predict_without_model(
        self,
        days_to_predict: int,
        use_dummy_data: bool,
        node_id: Optional[str] = None,
    ) -> list[ForecastResult]:
        """
        Free-tier fallback: returns heuristic forecasts when model artifacts are
        unavailable. Intended for dummy-mode continuity, not production-grade ML.
        """
        df = await self._load_history(use_dummy_data, node_id)
        return self._heuristic_predictions(df, days_to_predict)

    async def predict_batch(
        self,
        node_ids: list[str],
        days_to_predict: int,
        use_dummy_data: bool,
        horizon: Optional[int] = None,
        model_scope: Optional[str] = None,
    ) -> tuple[list[NodeForecast], list[dict]]:
        forecasts: list[NodeForecast] = []
        errors: list[dict] = []
        sem = asyncio.Semaphore(BATCH_CONCURRENCY)

        async def run_one(node_id: str) -> None:
            async with sem:
                try:
                    results, ctx = await self._forecast_for_node(
                        days_to_predict, use_dummy_data, node_id,
                        model_version=None, horizon=horizon, model_scope=model_scope,
                    )
                    forecasts.append(NodeForecast(
                        node_id=node_id, predictions=results,
                        model_scope=ctx.scope, horizon=ctx.horizon,
                        model_version=ctx.version,
                    ))
                except InsufficientDataError as exc:
                    errors.append(
                        {"node_id": node_id, "error_code": exc.error_code, "detail": exc.message}
                    )
                except AppError as exc:
                    errors.append({"node_id": node_id, "error_code": exc.error_code, "detail": exc.message})
                except Exception as exc:
                    errors.append({"node_id": node_id, "error_code": "FORECAST_ERROR", "detail": str(exc)})

        await asyncio.gather(*(run_one(node_id) for node_id in node_ids))

        if not forecasts:
            raise BatchForecastError(errors)

        if errors:
            logger.warning("Batch forecast partial failures: %s", errors)

        return forecasts, errors

    async def predict_batch_without_model(
        self,
        node_ids: list[str],
        days_to_predict: int,
        use_dummy_data: bool,
    ) -> tuple[list[NodeForecast], list[dict]]:
        forecasts: list[NodeForecast] = []
        errors: list[dict] = []
        sem = asyncio.Semaphore(BATCH_CONCURRENCY)

        async def run_one(node_id: str) -> None:
            async with sem:
                try:
                    results = await self.predict_without_model(
                        days_to_predict, use_dummy_data, node_id
                    )
                    forecasts.append(NodeForecast(node_id=node_id, predictions=results))
                except InsufficientDataError as exc:
                    errors.append(
                        {"node_id": node_id, "error_code": exc.error_code, "detail": exc.message}
                    )
                except Exception as exc:
                    errors.append(
                        {"node_id": node_id, "error_code": "FORECAST_ERROR", "detail": str(exc)}
                    )

        await asyncio.gather(*(run_one(node_id) for node_id in node_ids))

        if not forecasts:
            raise BatchForecastError(errors)

        if errors:
            logger.warning("Batch heuristic forecast partial failures: %s", errors)

        return forecasts, errors

    async def _forecast_for_node(
        self,
        days_to_predict: int,
        use_dummy_data: bool,
        node_id: Optional[str] = None,
        model_version: Optional[str] = None,
        horizon: Optional[int] = None,
        model_scope: Optional[str] = None,
    ) -> tuple[list[ForecastResult], ForecastContext]:
        """Module 4.3.5 — resolve model by node_id (per-node or global), then
        run a single multi-horizon forward pass when the model supports it, else
        fall back to the recursive single-step roll-forward."""
        label = node_id or "aggregate"
        logger.info(
            "Forecasting node=%s dummy=%s days=%s version=%s scope=%s horizon_req=%s",
            label, use_dummy_data, days_to_predict, model_version or "default",
            model_scope or "auto", horizon,
        )

        # 1. Resolve model + scaler + metadata + served scope/version.
        if model_version is not None:
            # Explicit global registry version always wins (A/B / pinned).
            model, scaler, metadata, resolved = self._model_store.get_version(model_version)
            scope, version = "global", resolved
        elif node_id and model_scope != "global":
            try:
                model, scaler, metadata, scope = await self._load_node_model(node_id)
            except FileNotFoundError:
                # No per-node artifact and no registry-global model; fall back to
                # ModelStore's default (primary model.keras path included).
                model, scaler, metadata, resolved = self._model_store.get_version(None)
                scope, version = "global", resolved
            else:
                if scope == "global":
                    # Per-node artifact missing → fell back to global default. Prefer
                    # the ModelStore's already-loaded global model to avoid duplicates.
                    model, scaler, metadata, resolved = self._model_store.get_version(None)
                    scope, version = "global", resolved
                else:
                    version = (metadata or {}).get("version")
        else:
            model, scaler, metadata, resolved = self._model_store.get_version(None)
            scope, version = "global", resolved

        # 2. Determine the model's native horizon (1 = legacy single-step).
        meta = metadata or {}
        try:
            model_horizon = int((meta.get("preprocessing", {}) or {}).get("horizon", 1) or 1)
        except (TypeError, ValueError):
            model_horizon = 1
        if model_horizon < 1:
            model_horizon = 1

        # 3. Load history + build the look-back input window.
        df = await self._load_history(use_dummy_data, node_id)
        sequence = prepare_for_prediction(df, scaler, look_back=self._settings.look_back_days)

        metrics = meta.get("metrics", {}) or {}

        if model_horizon > 1:
            # Native multi-horizon: ONE forward pass for the whole horizon.
            raw = await asyncio.to_thread(
                predict_multi_horizon, model, sequence, model_horizon, scaler
            )
            steps = max(1, min(int(days_to_predict), model_horizon))
            if steps < model_horizon:
                logger.info(
                    "Truncating native horizon %d to requested %d steps for node=%s",
                    model_horizon, steps, label,
                )
            per_step = metrics.get("per_step")
            results = self._format_predictions(
                raw[:steps], df.index[-1], per_step_bands=per_step, tag_horizon_steps=True
            )
            ctx = ForecastContext(scope=scope, version=version, horizon=model_horizon)
        else:
            # Legacy recursive single-step model.
            raw = await asyncio.to_thread(
                predict_future, model, sequence, int(days_to_predict), scaler
            )
            bands = metrics.get("conformal")
            results = self._format_predictions(raw, df.index[-1], bands=bands)
            ctx = ForecastContext(scope=scope, version=version, horizon=None)

        return results, ctx

    async def _load_history(self, use_dummy_data: bool, node_id: Optional[str]):
        label = node_id or "aggregate"
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
        return df

    @staticmethod
    def _heuristic_predictions(df, days_to_predict: int) -> list[ForecastResult]:
        """
        Lightweight deterministic baseline based on recent moving averages +
        trend. Keeps forecast endpoint usable when model artifacts are missing.
        """
        recent = df.tail(min(21, len(df)))
        gen_base = float(recent["generation"].mean())
        cons_base = float(recent["consumption"].mean())

        if len(recent) >= 2:
            gen_slope = float(recent["generation"].iloc[-1] - recent["generation"].iloc[0]) / (len(recent) - 1)
            cons_slope = float(recent["consumption"].iloc[-1] - recent["consumption"].iloc[0]) / (len(recent) - 1)
        else:
            gen_slope = 0.0
            cons_slope = 0.0

        # Use latest known timestamp when available.
        last_date = df.index[-1] if len(df.index) > 0 else datetime.utcnow()
        rows = []
        for i in range(days_to_predict):
            day = i + 1
            generation_value = max(0.0, gen_base + gen_slope * day * 0.35)
            consumption_value = max(0.0, cons_base + cons_slope * day * 0.35)

            confidence = max(0.35, 0.75 - (i * 0.04))
            uncertainty_pct = (1.0 - confidence) + 0.08
            gen_margin = abs(generation_value) * uncertainty_pct
            cons_margin = abs(consumption_value) * uncertainty_pct

            pred_date = last_date + timedelta(days=day)
            rows.append(
                ForecastResult(
                    timestamp=pred_date,
                    predicted_generation=generation_value,
                    predicted_consumption=consumption_value,
                    generation_lower=max(0.0, generation_value - gen_margin),
                    generation_upper=generation_value + gen_margin,
                    consumption_lower=max(0.0, consumption_value - cons_margin),
                    consumption_upper=consumption_value + cons_margin,
                    confidence=confidence,
                )
            )
        return rows

    @staticmethod
    def _format_predictions(
        predictions,
        last_date,
        bands: Optional[dict[str, Any]] = None,
        per_step_bands: Optional[list] = None,
        tag_horizon_steps: bool = False,
    ) -> list[ForecastResult]:
        """Format raw (n, 2) predictions into ForecastResult rows.

        ``per_step_bands`` (Module 4.3) is the multi-horizon per-step list from
        model metrics; each entry has a ``conformal`` dict with native per-step
        margins that already encode horizon growth (no sqrt scaling needed).
        ``bands`` is the legacy single-conformal dict used with sqrt scaling.
        ``tag_horizon_steps`` adds a 1-indexed ``horizon_step`` to each row.
        """
        conformal = bool(bands) and "generation_margin" in (bands or {})
        results = []
        for i, pred in enumerate(predictions):
            pred_date = last_date + timedelta(days=i + 1)
            generation_value = float(pred[0])
            consumption_value = float(pred[1])

            step_bands = None
            if per_step_bands is not None and i < len(per_step_bands):
                step_bands = (per_step_bands[i] or {}).get("conformal")

            if step_bands and "generation_margin" in step_bands:
                # Native per-step conformal margins (multi-horizon direct model).
                alpha = min(0.5, max(0.01, float(step_bands.get("alpha", 0.1))))
                confidence = max(0.5, min(0.99, 1.0 - alpha))
                generation_margin = abs(float(step_bands.get("generation_margin", 0.0)))
                consumption_margin = abs(float(step_bands.get("consumption_margin", 0.0)))
            elif conformal:
                # Module 4.2.4 — calibrated conformal bands from training
                # residuals. Uncertainty grows with horizon via sqrt scaling.
                alpha = min(0.5, max(0.01, float(bands.get("alpha", 0.1))))
                confidence = max(0.5, min(0.99, 1.0 - alpha))
                horizon_scale = math.sqrt(i + 1)
                generation_margin = abs(float(bands.get("generation_margin", 0.0))) * horizon_scale
                consumption_margin = abs(float(bands.get("consumption_margin", 0.0))) * horizon_scale
            else:
                # Heuristic fallback when no conformal data is available.
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
                    horizon_step=(i + 1) if tag_horizon_steps else None,
                )
            )
        return results

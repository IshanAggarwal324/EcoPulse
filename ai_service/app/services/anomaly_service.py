"""Inference service for meter anomaly scoring (Module 4.1.4).

``score_readings(node_id, window_days)`` pulls recent readings from MongoDB,
runs the Isolation-Forest detector off the event loop, and returns flagged
timestamps. A batch variant feeds the admin dashboard / assistant.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from app.config import Settings
from app.exceptions import InsufficientDataError, ModelUnavailableError
from app.services.anomaly_store import AnomalyStore
from models.anomaly_detection import detect as detect_anomalies
from models.anomaly_preprocessing import build_feature_frame
from utils.database import get_historical_data

logger = logging.getLogger(__name__)


class AnomalyService:
    def __init__(self, anomaly_store: AnomalyStore, settings: Settings):
        self._store = anomaly_store
        self._settings = settings

    def is_ready(self) -> bool:
        return self._store.is_ready

    @property
    def model_version(self) -> Optional[str]:
        return self._store.model_version

    def _lookback_days(self, window_days: int) -> int:
        buffer = max(self._settings.anomaly_feature_window, 7)
        return window_days + buffer

    async def score_readings(self, node_id: Optional[str], window_days: int) -> Dict[str, Any]:
        self._store.ensure_ready()

        df = await get_historical_data(
            use_dummy=self._settings.allow_model_free_dummy,
            days=self._lookback_days(window_days),
            node_id=node_id,
        )
        if df is None or len(df) == 0:
            raise InsufficientDataError("Not enough readings to score anomalies")

        frame = build_feature_frame(df, window=self._settings.anomaly_feature_window)
        calib = self._store.feature_config.get("calibration", {})
        flagged: List[Dict[str, Any]] = await asyncio.to_thread(
            detect_anomalies,
            self._store.model,
            frame,
            calib=calib,
            threshold=self._settings.anomaly_score_threshold,
            zcap=self._settings.anomaly_zscore_cap,
            max_results=self._settings.anomaly_max_results,
        )
        return {
            "node_id": node_id,
            "window_days": window_days,
            "model_version": self._store.model_version,
            "total_readings": int(len(frame)),
            "flagged": flagged,
            "flagged_count": len(flagged),
        }

    async def batch_score(self, node_ids: List[str], window_days: int) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        for nid in node_ids:
            try:
                results.append(await self.score_readings(nid, window_days))
            except (InsufficientDataError, ModelUnavailableError) as exc:
                logger.info("Anomaly batch skipped node %s: %s", nid, exc)
                results.append(
                    {
                        "node_id": nid,
                        "window_days": window_days,
                        "error": str(exc),
                        "flagged": [],
                        "flagged_count": 0,
                    }
                )
        return results

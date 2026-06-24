from pydantic import BaseModel, Field, field_validator
from typing import Any, Dict, List, Optional
from datetime import datetime
import re

_VERSION_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


class ErrorResponse(BaseModel):
    success: bool = False
    message: str
    error_code: str
    details: Optional[Any] = None

class EnergyReading(BaseModel):
    timestamp: datetime
    generation: float
    consumption: float

class ForecastRequest(BaseModel):
    days_to_predict: int = Field(default=7, ge=1, le=90)
    use_dummy_data: bool = False
    model_version: Optional[str] = None
    node_id: Optional[str] = Field(default=None, max_length=128)

    @field_validator("model_version")
    @classmethod
    def validate_model_version(cls, v):
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not _VERSION_RE.match(v):
            raise ValueError("model_version must be alphanumeric, underscore or hyphen (max 64 chars)")
        return v

class BatchForecastRequest(BaseModel):
    days_to_predict: int = Field(default=7, ge=1, le=90)
    use_dummy_data: bool = False
    node_ids: List[str] = Field(..., min_length=1, max_length=50)

    @field_validator("node_ids")
    @classmethod
    def validate_node_ids(cls, v):
        cleaned = []
        for nid in v:
            nid = nid.strip()
            if not nid or len(nid) > 128:
                raise ValueError("Each node_id must be between 1 and 128 characters")
            cleaned.append(nid)
        return cleaned

class ForecastResult(BaseModel):
    timestamp: datetime
    predicted_generation: float
    predicted_consumption: float
    generation_lower: float
    generation_upper: float
    consumption_lower: float
    consumption_upper: float
    confidence: float

class NodeForecast(BaseModel):
    node_id: str
    predictions: List[ForecastResult]

class ForecastResponse(BaseModel):
    predictions: List[ForecastResult]
    model_status: str
    model_version: Optional[str] = None
    node_id: Optional[str] = None

class BatchForecastResponse(BaseModel):
    forecasts: List[NodeForecast]
    model_status: str
    model_version: Optional[str] = None


class AnomalyScoreRequest(BaseModel):
    node_id: Optional[str] = Field(default=None, max_length=128)
    window_days: int = Field(default=7, ge=1, le=90)


class AnomalyBatchRequest(BaseModel):
    node_ids: List[str] = Field(..., min_length=1, max_length=50)
    window_days: int = Field(default=7, ge=1, le=90)

    @field_validator("node_ids")
    @classmethod
    def validate_node_ids(cls, v):
        cleaned = []
        for nid in v:
            nid = (nid or "").strip()
            if not nid or len(nid) > 128:
                raise ValueError("Each node_id must be between 1 and 128 characters")
            cleaned.append(nid)
        return cleaned


class AnomalyFlaggedReading(BaseModel):
    timestamp: datetime
    generation: float
    consumption: float
    anomaly_score: float = Field(ge=0.0, le=1.0)
    is_anomaly: bool
    reason_codes: List[str] = []


class AnomalyScoreResponse(BaseModel):
    node_id: Optional[str] = None
    window_days: int
    model_status: str
    model_version: Optional[str] = None
    total_readings: int
    flagged_count: int
    flagged: List[AnomalyFlaggedReading] = []


class AnomalyBatchResponse(BaseModel):
    results: List[AnomalyScoreResponse]
    model_status: str
    model_version: Optional[str] = None


# ---------------------------------------------------------------------------
# Module 4.2 — model lifecycle schemas (confidence, versions, A/B, drift)
# ---------------------------------------------------------------------------


class ConfidenceResponse(BaseModel):
    model_version: Optional[str] = None
    uncertainty_method: str
    alpha: Optional[float] = None
    calibration_metrics: Dict[str, Any] = {}
    mape_generation: Optional[float] = None
    mape_consumption: Optional[float] = None
    rmse_generation: Optional[float] = None
    rmse_consumption: Optional[float] = None
    n_samples: Optional[int] = None


class ModelVersionInfo(BaseModel):
    version: str
    saved_at_utc: Optional[str] = None
    data_source: Optional[str] = None
    n_rows: Optional[int] = None
    mape_generation: Optional[float] = None
    mape_consumption: Optional[float] = None
    promoted: bool = False


class ModelVersionsResponse(BaseModel):
    latest_version: Optional[str] = None
    versions: List[ModelVersionInfo] = []


class ModelCompareResponse(BaseModel):
    versionA: str
    versionB: str
    versionA_mape: Optional[float] = None
    versionB_mape: Optional[float] = None
    mape_delta: Optional[float] = None
    live_champion_mape: Optional[float] = None
    live_challenger_mape: Optional[float] = None
    live_samples: int = 0
    versionA_conformal: Optional[Dict[str, Any]] = None
    versionB_conformal: Optional[Dict[str, Any]] = None


class PromoteModelRequest(BaseModel):
    version: str

    @field_validator("version")
    @classmethod
    def validate_version(cls, v):
        v = (v or "").strip()
        if not _VERSION_RE.match(v):
            raise ValueError("version must be alphanumeric, underscore or hyphen (max 64 chars)")
        return v


class DriftReportResponse(BaseModel):
    status: str
    recent_mape: Optional[float] = None
    baseline_mape: Optional[float] = None
    relative_increase: Optional[float] = None
    threshold: float
    samples: int
    details: Dict[str, Any] = {}

from pydantic import BaseModel, Field, field_validator
from typing import Any, List, Optional
from datetime import datetime


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
    node_id: Optional[str] = None

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

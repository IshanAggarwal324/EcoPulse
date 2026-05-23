from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

class EnergyReading(BaseModel):
    timestamp: datetime
    generation: float
    consumption: float

class ForecastRequest(BaseModel):
    days_to_predict: int = 7
    use_dummy_data: bool = True

class ForecastResult(BaseModel):
    timestamp: datetime
    predicted_generation: float
    predicted_consumption: float

class ForecastResponse(BaseModel):
    predictions: List[ForecastResult]
    model_status: str

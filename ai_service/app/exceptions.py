from typing import Any, Optional


class AppError(Exception):
    """Base application error with HTTP mapping metadata."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 500,
        error_code: str = "INTERNAL_ERROR",
        details: Optional[Any] = None,
    ):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.error_code = error_code
        self.details = details


class ModelUnavailableError(AppError):
    def __init__(self, details: Optional[Any] = None):
        super().__init__(
            "Model is not trained or unavailable. Please run train.py first.",
            status_code=503,
            error_code="MODEL_UNAVAILABLE",
            details=details,
        )


class InsufficientDataError(AppError):
    def __init__(self, node_id: Optional[str] = None):
        label = node_id or "aggregate"
        super().__init__(
            f"Insufficient historical data for node {label}",
            status_code=400,
            error_code="INSUFFICIENT_DATA",
            details={"node_id": node_id},
        )


class BatchForecastError(AppError):
    def __init__(self, errors: list[dict]):
        super().__init__(
            "No forecasts could be generated for the requested nodes",
            status_code=500,
            error_code="BATCH_FORECAST_FAILED",
            details={"errors": errors},
        )

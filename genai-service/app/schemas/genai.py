from typing import Any, Optional

from pydantic import BaseModel, Field


class ReportMetrics(BaseModel):
    grid_energy: Optional[dict[str, Any]] = Field(
        default=None,
        alias="gridEnergy",
        description="Grid-wide energy totals: totalGenerated, totalConsumed, netEnergy, readingCount",
    )
    grid_trading: Optional[dict[str, Any]] = Field(
        default=None,
        alias="gridTrading",
        description="Grid trading stats: completedTrades, totalEnergyTraded, totalVolumeCredits, dailyVolume",
    )
    node_overview: Optional[dict[str, Any]] = Field(
        default=None,
        alias="nodeOverview",
        description="Node stats: activeNodes, totalNodes, byStatus",
    )
    personal_profit: Optional[dict[str, Any]] = Field(
        default=None,
        alias="personalProfit",
        description="Wallet profit: creditsReceived, creditsSpent, netFlow, saleCount, purchaseCount. Null when no wallet.",
    )
    carbon: Optional[dict[str, Any]] = Field(
        default=None,
        description="Carbon stats: totalCreditsTraded, walletBalance, estimatedGridCredits. Null when no wallet.",
    )
    period_label: str = Field(
        alias="periodLabel",
        description="Human-readable period label, e.g. 'Last 7 days'",
    )

    model_config = {"populate_by_name": True}


class ReportMeta(BaseModel):
    is_demo_data: bool = Field(
        alias="isDemoData",
        description="True when report is based on simulated/demo data",
    )
    period: str = Field(
        description="Period code: 7d, 14d, or 30d",
        pattern=r"^\d+d$",
    )
    scope: str = Field(
        description="Report scope: personal, grid, or both",
        pattern=r"^(personal|grid|both)$",
    )
    generated_at: str = Field(
        alias="generatedAt",
        description="ISO 8601 timestamp when report was generated",
    )
    wallet_connected: bool = Field(
        alias="walletConnected",
        description="Whether a wallet was connected for personal sections",
    )

    model_config = {"populate_by_name": True}


class ReportNarrateRequest(BaseModel):
    metrics: ReportMetrics = Field(
        description="Pre-computed report metrics from reportService"
    )
    meta: ReportMeta = Field(
        description="Report metadata including period, scope, and data source info"
    )


class ReportNarrateResponse(BaseModel):
    summary: str = Field(
        description="2-4 paragraph narrative summarising the report"
    )
    highlights: list[str] = Field(
        min_length=1,
        max_length=8,
        description="Key highlights as short bullet strings",
    )
    disclaimer: str = Field(
        description="Data source disclaimer, e.g. demo data notice"
    )

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


class DocChunk(BaseModel):
    doc_id: str = Field(
        alias="docId",
        description="Source document identifier, e.g. 'trading-guide.md'",
    )
    title: str = Field(
        description="Section or document title",
    )
    excerpt: str = Field(
        description="Relevant text excerpt from the document",
    )

    model_config = {"populate_by_name": True}


class ConversationTurn(BaseModel):
    role: str = Field(
        description="Speaker role: 'user' or 'assistant'",
        pattern=r"^(user|assistant)$",
    )
    content: str = Field(
        description="Message text for this turn",
    )


class AssistantChatRequest(BaseModel):
    message: str = Field(
        min_length=1,
        description="User's chat message",
    )
    retrieved_data: Optional[dict[str, Any]] = Field(
        default=None,
        alias="retrieved_data",
        description="Pre-fetched analytics data relevant to the message",
    )
    doc_chunks: Optional[list[DocChunk]] = Field(
        default=None,
        alias="doc_chunks",
        description="Optional document RAG excerpts for FAQ-style questions",
    )
    conversation_history: Optional[list[ConversationTurn]] = Field(
        default=None,
        alias="conversation_history",
        description="Prior conversation turns for multi-turn context",
    )

    model_config = {"populate_by_name": True}


class AssistantChatResponse(BaseModel):
    reply: str = Field(
        description="Assistant's reply to the user message"
    )
    disclaimer: str = Field(
        description="Data source disclaimer, e.g. demo data notice"
    )

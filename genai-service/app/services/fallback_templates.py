from typing import Any


def render_report_summary(metrics: dict[str, Any]) -> str:
    lines: list[str] = []
    period = metrics.get("meta", {}).get("period", "N/A")
    scope = metrics.get("meta", {}).get("scope", "both")
    is_demo = metrics.get("meta", {}).get("isDemoData", True)

    lines.append(f"## EcoPulse Energy Report — Last {period}\n")

    grid = metrics.get("gridEnergy")
    if grid:
        gen_val = grid.get("totalGenerated", "N/A")
        con_val = grid.get("totalConsumed", "N/A")
        count = grid.get("readingCount", "N/A")
        lines.append(f"**Grid Energy:** Generated {gen_val} kWh, Consumed {con_val} kWh ({count} readings).")

    trading = metrics.get("gridTrading")
    if trading:
        vol = trading.get("totalVolume", trading.get("totalTrades", "N/A"))
        lines.append(f"**Grid Trading:** Total volume: {vol}.")

    profit = metrics.get("personalProfit")
    if profit and scope in ("personal", "both"):
        net = profit.get("netFlow", "N/A")
        sales = profit.get("salesCount", 0)
        purchases = profit.get("purchaseCount", 0)
        lines.append(
            f"**Personal Profit:** Net flow {net} CC across {sales} sales and {purchases} purchases."
        )

    nodes = metrics.get("nodeOverview")
    if nodes:
        active = nodes.get("activeNodes", "N/A")
        total = nodes.get("totalNodes", "N/A")
        lines.append(f"**Nodes:** {active} active out of {total} total.")

    carbon = metrics.get("carbon")
    if carbon and scope in ("personal", "both"):
        bal = carbon.get("balance", carbon.get("totalCredits", "N/A"))
        lines.append(f"**Carbon Credits:** Balance {bal} CC.")

    if is_demo:
        lines.append("\n*Based on simulated demo data.*")

    return "\n".join(lines)


def render_chat_reply(
    message: str,
    retrieved_data: dict[str, Any] | None = None,
    intent: str | None = None,
) -> str:
    parts: list[str] = []

    if not retrieved_data:
        return (
            "I don't have live data available to answer that question right now. "
            "Please try again later or contact support if the issue persists."
        )

    # Explanation-only payloads (e.g. "no wallet connected", "no nodes yet").
    explanation = retrieved_data.get("explanation")
    if explanation and len(retrieved_data) <= 2:
        return str(explanation)

    # Sub-module 3.2/3.3 — bill analysis & recent readings shapes.
    if "totalConsumedKwh" in retrieved_data:
        consumed = retrieved_data.get("totalConsumedKwh")
        generated = retrieved_data.get("totalGeneratedKwh")
        if isinstance(generated, (int, float)):
            parts.append(f"You generated **{generated} kWh** and consumed **{consumed} kWh**.")
        else:
            parts.append(f"You consumed **{consumed} kWh**.")

        delta = retrieved_data.get("deltaPercent")
        if isinstance(delta, (int, float)):
            prior = retrieved_data.get("priorPeriodConsumedKwh")
            direction = "up" if delta >= 0 else "down"
            parts.append(
                f"That's {direction} {abs(delta)}% versus the prior period"
                f"{' (' + str(prior) + ' kWh)' if prior is not None else ''}."
            )

        top_nodes = retrieved_data.get("topNodes") or []
        if top_nodes:
            names = ", ".join(
                f"{n.get('name')} ({n.get('consumedKwh')} kWh)"
                for n in top_nodes[:3]
                if isinstance(n, dict)
            )
            if names:
                parts.append(f"Top consumers: {names}.")

        anomalies = retrieved_data.get("anomalies") or []
        for a in anomalies[:2]:
            if isinstance(a, dict) and a.get("name"):
                parts.append(f"Spike on {a.get('name')}: {a.get('reason', 'usage well above the prior period')}.")

    # User-node context (3.2.6).
    if "nodeCount" in retrieved_data:
        nodes = retrieved_data.get("nodes") or []
        active = retrieved_data.get("activeCount")
        parts.append(
            f"You have **{retrieved_data.get('nodeCount')}** node(s)"
            f"{(' (' + str(active) + ' active)') if active is not None else ''}."
        )
        if nodes:
            names = ", ".join(n.get("name", "node") for n in nodes[:5] if isinstance(n, dict))
            if names:
                parts.append(f"Nodes: {names}.")

    # Legacy grid-energy shape.
    if "totalGenerated" in retrieved_data or "totalConsumed" in retrieved_data:
        gen = retrieved_data.get("totalGenerated", "N/A")
        con = retrieved_data.get("totalConsumed", "N/A")
        parts.append(f"Grid generated **{gen} kWh** and consumed **{con} kWh**.")

    if "netFlow" in retrieved_data:
        net = retrieved_data["netFlow"]
        parts.append(f"Your wallet net flow is **{net} CC**.")

    if "activeNodes" in retrieved_data:
        active = retrieved_data["activeNodes"]
        total = retrieved_data.get("totalNodes", "N/A")
        parts.append(f"Active nodes: **{active}** out of **{total}**.")

    # Trades — extended with active listings + unit-price trend.
    if (
        "completedTrades" in retrieved_data
        or "totalEnergyTraded" in retrieved_data
        or "totalListings" in retrieved_data
    ):
        completed = retrieved_data.get("completedTrades", "N/A")
        energy = retrieved_data.get("totalEnergyTraded", "N/A")
        parts.append(f"**{completed}** completed trades totalling **{energy} kWh**.")
        active_listings = retrieved_data.get("activeListings")
        if isinstance(active_listings, (int, float)):
            parts.append(f"**{active_listings}** listings are currently active.")
        trend = retrieved_data.get("unitPriceTrend") or []
        if isinstance(trend, list) and len(trend) >= 2:
            last = trend[-1]
            price = last.get("avgUnitPriceCc") if isinstance(last, dict) else None
            if isinstance(price, (int, float)):
                parts.append(f"Latest average unit price is around **{price} CC/kWh**.")

    if "walletBalance" in retrieved_data or "totalCreditsTraded" in retrieved_data:
        bal = retrieved_data.get("walletBalance", retrieved_data.get("totalCreditsTraded", "N/A"))
        parts.append(f"Carbon credit balance: **{bal} CC**.")

    # Forecast.
    forecast = retrieved_data.get("forecast")
    if isinstance(forecast, dict) and retrieved_data.get("available"):
        mode = forecast.get("mode", "aggregate")
        node_label = f" for {forecast.get('nodeName')}" if forecast.get("nodeName") else ""
        parts.append(f"A 7-day forecast is available{node_label} (mode: {mode}).")

    if not parts:
        available_keys = ", ".join(retrieved_data.keys())
        parts.append(
            f"I found data ({available_keys}) but couldn't format a specific answer. "
            "Please rephrase your question."
        )

    return " ".join(parts)

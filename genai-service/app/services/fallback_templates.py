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


def render_chat_reply(message: str, retrieved_data: dict[str, Any] | None = None) -> str:
    parts: list[str] = []

    if not retrieved_data:
        return (
            "I don't have live data available to answer that question right now. "
            "Please try again later or contact support if the issue persists."
        )

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

    if "totalTrades" in retrieved_data or "totalVolume" in retrieved_data:
        trades = retrieved_data.get("totalTrades", retrieved_data.get("totalVolume", "N/A"))
        parts.append(f"Trade volume: **{trades}**.")

    if "balance" in retrieved_data or "totalCredits" in retrieved_data:
        bal = retrieved_data.get("balance", retrieved_data.get("totalCredits", "N/A"))
        parts.append(f"Carbon credit balance: **{bal} CC**.")

    if not parts:
        available_keys = ", ".join(retrieved_data.keys())
        parts.append(
            f"I found data ({available_keys}) but couldn't format a specific answer. "
            "Please rephrase your question."
        )

    return " ".join(parts)

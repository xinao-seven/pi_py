"""Session-wide token, cost, and message statistics."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from pi_coding_agent.core.session_manager import SessionEntry


def get_session_stats(
    entries: list[SessionEntry],
    *,
    session_id: str,
    session_file: Path | None,
    context_usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    counts = {"userMessages": 0, "assistantMessages": 0, "toolCalls": 0, "toolResults": 0, "totalMessages": 0}
    totals = _empty_totals()
    for entry in entries:
        entry_type = entry.get("type")
        if entry_type in {"branch_summary", "compaction"}:
            _add_usage(totals, entry.get("usage"))
        if entry_type != "message" or not isinstance(entry.get("message"), dict):
            continue
        counts["totalMessages"] += 1
        message = entry["message"]
        role = message.get("role")
        if role == "user":
            counts["userMessages"] += 1
        elif role == "toolResult":
            counts["toolResults"] += 1
            _add_usage(totals, message.get("usage"))
        elif role == "assistant":
            counts["assistantMessages"] += 1
            content = message.get("content", [])
            if isinstance(content, list):
                counts["toolCalls"] += sum(
                    1 for block in content if isinstance(block, dict) and block.get("type") == "toolCall"
                )
            _add_usage(totals, message.get("usage"))
    tokens = {key: int(totals[key]) for key in ("input", "output", "cacheRead", "cacheWrite")}
    tokens["total"] = sum(tokens.values())
    return {
        "sessionFile": str(session_file) if session_file is not None else None,
        "sessionId": session_id,
        **counts,
        "tokens": tokens,
        "cost": totals["cost"],
        "contextUsage": context_usage,
    }


def get_usage_cost_breakdown(entries: list[SessionEntry]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, float]] = defaultdict(_empty_totals)
    for entry in entries:
        usage: Any = None
        key: str | None = None
        if entry.get("type") == "message" and isinstance(entry.get("message"), dict):
            message = entry["message"]
            if message.get("role") == "assistant":
                provider = message.get("provider", "unknown")
                model = message.get("responseModel") or message.get("model", "unknown")
                key, usage = f"{provider}/{model}", message.get("usage")
            elif message.get("role") == "toolResult":
                key, usage = "Tools/summaries", message.get("usage")
        elif entry.get("type") in {"branch_summary", "compaction"}:
            key, usage = "Tools/summaries", entry.get("usage")
        if key and isinstance(usage, dict):
            _add_usage(grouped[key], usage)
    result = [
        {
            "key": key,
            "cost": totals["cost"],
            "tokens": int(totals["input"] + totals["output"] + totals["cacheRead"] + totals["cacheWrite"]),
        }
        for key, totals in grouped.items()
        if totals["cost"] > 0 or any(totals[field] > 0 for field in ("input", "output", "cacheRead", "cacheWrite"))
    ]
    return sorted(result, key=lambda item: item["cost"], reverse=True)


def _empty_totals() -> dict[str, float]:
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0}


def _add_usage(totals: dict[str, float], usage: Any) -> None:
    if not isinstance(usage, dict):
        return
    for key in ("input", "output", "cacheRead", "cacheWrite"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            totals[key] += value
    cost = usage.get("cost")
    if isinstance(cost, dict) and isinstance(cost.get("total"), (int, float)):
        totals["cost"] += cost["total"]

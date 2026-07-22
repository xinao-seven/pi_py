"""Context token estimation compatible with pi's usage-first strategy."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from typing import Any

CHARS_PER_TOKEN = 4
ESTIMATED_IMAGE_CHARS = 4800


@dataclass(frozen=True, slots=True)
class ContextUsageEstimate:
    tokens: int
    usage_tokens: int
    trailing_tokens: int
    last_usage_index: int | None


def calculate_context_tokens(usage: dict[str, Any]) -> int:
    total = usage.get("totalTokens")
    if isinstance(total, (int, float)) and total > 0:
        return int(total)
    return sum(_nonnegative_int(usage.get(key)) for key in ("input", "output", "cacheRead", "cacheWrite"))


def estimate_message_tokens(message: dict[str, Any]) -> int:
    role = message.get("role")
    content = message.get("content", "")
    if role in {"user", "toolResult"}:
        return math.ceil(_content_chars(content) / CHARS_PER_TOKEN)
    if role != "assistant" or not isinstance(content, list):
        return math.ceil(len(_safe_json(content)) / CHARS_PER_TOKEN)
    chars = 0
    for block in content:
        if not isinstance(block, dict):
            chars += len(_safe_json(block))
        elif block.get("type") == "text":
            chars += len(str(block.get("text", "")))
        elif block.get("type") == "thinking":
            chars += len(str(block.get("thinking", "")))
        elif block.get("type") == "toolCall":
            chars += len(str(block.get("name", ""))) + len(_safe_json(block.get("arguments", {})))
    return math.ceil(chars / CHARS_PER_TOKEN)


def estimate_context_tokens(
    messages: list[dict[str, Any]],
    *,
    system_prompt: str = "",
    tools: list[dict[str, Any]] | None = None,
) -> ContextUsageEstimate:
    usage_index: int | None = None
    usage_tokens = 0
    latest_prefix_timestamp = float("-inf")
    for index, message in enumerate(messages):
        timestamp = _timestamp(message)
        if message.get("role") == "assistant":
            usage = message.get("usage")
            if (
                timestamp >= latest_prefix_timestamp
                and message.get("stopReason") not in {"aborted", "error"}
                and isinstance(usage, dict)
            ):
                tokens = calculate_context_tokens(usage)
                if tokens > 0:
                    usage_index = index
                    usage_tokens = tokens
        latest_prefix_timestamp = max(latest_prefix_timestamp, timestamp)

    if usage_index is not None:
        trailing = sum(estimate_message_tokens(message) for message in messages[usage_index + 1 :])
        return ContextUsageEstimate(usage_tokens + trailing, usage_tokens, trailing, usage_index)

    message_tokens = sum(estimate_message_tokens(message) for message in messages)
    prefix_tokens = math.ceil(len(system_prompt) / CHARS_PER_TOKEN)
    if tools:
        prefix_tokens += math.ceil(len(_safe_json(tools)) / CHARS_PER_TOKEN)
    total = message_tokens + prefix_tokens
    return ContextUsageEstimate(total, 0, total, None)


def _content_chars(content: Any) -> int:
    if isinstance(content, str):
        return len(content)
    if not isinstance(content, list):
        return len(_safe_json(content))
    chars = 0
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            chars += len(str(block.get("text", "")))
        elif isinstance(block, dict) and block.get("type") == "image":
            chars += ESTIMATED_IMAGE_CHARS
        else:
            chars += len(_safe_json(block))
    return chars


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return "[unserializable]"


def _nonnegative_int(value: Any) -> int:
    return int(value) if isinstance(value, (int, float)) and value > 0 else 0


def _timestamp(message: dict[str, Any]) -> float:
    value = message.get("timestamp", 0)
    return float(value) if isinstance(value, (int, float)) else 0.0

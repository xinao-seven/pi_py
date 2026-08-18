"""Context token estimation compatible with pi's usage-first strategy.

中文说明：上下文 token 估算，与 pi 的 usage-first 策略兼容：
优先采用模型最近一次返回的真实 usage，只对之后的尾部消息做估算；
没有真实 usage 时才全量估算。
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from typing import Any

# 粗略换算：约 4 个字符折合 1 个 token（各家厂商的简化估算）
CHARS_PER_TOKEN = 4
# 一张图片按固定字符数估算（无法精确预知模型对图片的编码消耗）
ESTIMATED_IMAGE_CHARS = 4800


@dataclass(frozen=True, slots=True)
class ContextUsageEstimate:
    """上下文估算结果：
    tokens 总占用；usage_tokens 来自模型真实 usage 的部分；
    trailing_tokens 是最近一次真实 usage 之后消息的估算值；
    last_usage_index 是最近一次真实 usage 所在消息的下标（无则为 None）。
    """
    tokens: int
    usage_tokens: int
    trailing_tokens: int
    last_usage_index: int | None


def calculate_context_tokens(usage: dict[str, Any]) -> int:
    """从 usage 字典换算 token 总数：优先 totalTokens，否则累加各分项。"""
    total = usage.get("totalTokens")
    if isinstance(total, (int, float)) and total > 0:
        return int(total)
    return sum(_nonnegative_int(usage.get(key)) for key in ("input", "output", "cacheRead", "cacheWrite"))


def estimate_message_tokens(message: dict[str, Any]) -> int:
    """按角色估算单条消息的 token 数：文本按字符数，assistant 按内容块类型分别折算。"""
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
    """估算整段上下文的 token 占用。

    遍历消息找到最近一条“成功”assistant 消息携带的真实 usage 作为基准
    （usage-first）；基准之后的消息按估算累加。若没有任何真实 usage，
    则对全部消息加上 system prompt 与工具定义做全量估算。
    """
    usage_index: int | None = None
    usage_tokens = 0
    latest_prefix_timestamp = float("-inf")
    # 从前往后扫描，保留时间戳最新的、成功的真实 usage 作为基准
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

    # 有真实 usage 基准：基准本身用真实值，其后消息用估算补齐
    if usage_index is not None:
        trailing = sum(estimate_message_tokens(message) for message in messages[usage_index + 1 :])
        return ContextUsageEstimate(usage_tokens + trailing, usage_tokens, trailing, usage_index)

    # 没有任何真实 usage：全量估算（消息 + system prompt + 工具定义）
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

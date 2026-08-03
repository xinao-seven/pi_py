"""Conversation compaction preparation and provider-backed summarization.

中文说明：上下文压缩（compaction）。当对话超过窗口阈值时，
把早期消息交给摘要器生成 checkpoint，只保留最近消息，
使长会话可以继续而不丢失关键上下文。
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any, Protocol

from pi_ai.providers.base import LLMProvider
from pi_ai.utils import estimate_context_tokens, estimate_message_tokens
from pi_coding_agent.core.session_manager import (
    SessionEntry,
    build_session_context,
    session_entry_to_context_messages,
)

SUMMARY_SYSTEM_PROMPT = (
    "You are a context summarization assistant. Do not continue the conversation. "
    "Only produce a concise checkpoint for another model."
)
SUMMARY_FORMAT = """Use this structure:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Preserve exact file paths, function names, commands, and error messages."""


@dataclass(frozen=True, slots=True)
class CompactionSettings:
    """压缩设置：是否启用、预留 token 数、保留最近消息的 token 预算。"""
    enabled: bool = True
    reserve_tokens: int = 16384
    keep_recent_tokens: int = 20000

    def __post_init__(self) -> None:
        if self.reserve_tokens < 0 or self.keep_recent_tokens < 0:
            raise ValueError("Compaction token settings must not be negative")


@dataclass(frozen=True, slots=True)
class CompactionPreparation:
    """一次压缩的准备结果：要摘要的消息、保留的尾部、压缩前 token 数与旧摘要。"""
    first_kept_entry_id: str
    messages_to_summarize: list[dict[str, Any]]
    retained_tail: list[dict[str, Any]]
    tokens_before: int
    previous_summary: str | None = None


@dataclass(frozen=True, slots=True)
class CompactionSummary:
    """摘要器产物：摘要文本与可选 usage。"""
    text: str
    usage: dict[str, Any] | None = None


class CompactionSummarizer(Protocol):
    # 摘要器协议：传入旧消息（与上次摘要），返回 CompactionSummary
    async def summarize(
        self,
        messages: list[dict[str, Any]],
        *,
        previous_summary: str | None = None,
        custom_instructions: str | None = None,
    ) -> CompactionSummary: ...


class ProviderCompactionSummarizer:
    """用当前 Provider 生成结构化摘要的实现（走一次无工具流式调用）。"""
    def __init__(self, provider: LLMProvider, model: str, *, thinking_level: str = "off") -> None:
        self.provider = provider
        self.model = model
        self.thinking_level = thinking_level

    async def summarize(
        self,
        messages: list[dict[str, Any]],
        *,
        previous_summary: str | None = None,
        custom_instructions: str | None = None,
    ) -> CompactionSummary:
        """把消息序列化为文本，按固定结构（目标/进度/决策/下一步等）请求摘要。"""
        conversation = json.dumps(messages, ensure_ascii=False, indent=2)
        prompt = f"<conversation>\n{conversation}\n</conversation>\n\n"
        if previous_summary:
            prompt += f"<previous-summary>\n{previous_summary}\n</previous-summary>\n\nUpdate the summary.\n"
        else:
            prompt += "Create a new checkpoint summary.\n"
        prompt += SUMMARY_FORMAT
        if custom_instructions:
            prompt += f"\n\nAdditional focus: {custom_instructions}"
        text_parts: list[str] = []
        usage: dict[str, Any] | None = None
        error: str | None = None
        async for event in self.provider.stream(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            tools=[],
            thinking_level=self.thinking_level,
            system_prompt=SUMMARY_SYSTEM_PROMPT,
        ):
            if event.get("type") == "text_delta":
                text_parts.append(str(event.get("text", "")))
            elif event.get("type") == "done":
                if isinstance(event.get("usage"), dict):
                    usage = dict(event["usage"])
                if event.get("error"):
                    error = str(event["error"])
        if error:
            raise RuntimeError(f"Compaction summarization failed: {error}")
        text = "".join(text_parts).strip()
        if not text:
            raise RuntimeError("Compaction summarization returned no text")
        return CompactionSummary(text=text, usage=usage)


def should_compact(context_tokens: int, context_window: int, settings: CompactionSettings) -> bool:
    """是否需要压缩：占用超过 窗口 - 预留 即触发。"""
    return settings.enabled and context_window > 0 and context_tokens > context_window - settings.reserve_tokens


def is_context_overflow(message: dict[str, Any], context_window: int = 0) -> bool:
    """判断一条 assistant 消息是否代表上下文溢出：
    错误消息按关键词匹配，正常消息则比较估算 token 是否超过窗口。"""
    if message.get("stopReason") != "error":
        usage = message.get("usage")
        return isinstance(usage, dict) and context_window > 0 and estimate_context_tokens([message]).tokens > context_window
    error = str(message.get("errorMessage", ""))
    return bool(
        re.search(
            r"context (?:length|window)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long|"
            r"input (?:is )?too long|context_length_exceeded",
            error,
            re.IGNORECASE,
        )
    )


def prepare_compaction(
    path_entries: list[SessionEntry],
    settings: CompactionSettings,
) -> CompactionPreparation | None:
    """计算压缩边界：从尾部向前累计保留最近的 keep_recent_tokens；
    裁剪点必须落在完整用户回合开头，避免拆散 tool call 与 toolResult。"""
    if not path_entries or path_entries[-1].get("type") == "compaction":
        return None
    # 找到上一次 compaction（如有），其后消息只做增量摘要
    previous_index = next(
        (index for index in range(len(path_entries) - 1, -1, -1) if path_entries[index].get("type") == "compaction"),
        -1,
    )
    previous_summary: str | None = None
    boundary_start = 0
    if previous_index >= 0:
        previous = path_entries[previous_index]
        previous_summary = str(previous.get("summary", "")) or None
        first_kept = previous.get("firstKeptEntryId")
        kept_index = next(
            (index for index, entry in enumerate(path_entries) if entry.get("id") == first_kept),
            -1,
        )
        boundary_start = kept_index if kept_index >= 0 else previous_index + 1

    entry_messages = [_entry_messages(entry) for entry in path_entries]
    accumulated = 0
    threshold_index = len(path_entries) - 1
    for index in range(len(path_entries) - 1, boundary_start - 1, -1):
        accumulated += sum(estimate_message_tokens(message) for message in entry_messages[index])
        threshold_index = index
        if accumulated >= settings.keep_recent_tokens:
            break

    # Retain complete user turns so assistant tool calls stay paired with all
    # following toolResult messages.
    # 说明：保留完整用户回合，使 assistant 工具调用与后续 toolResult 保持配对。
    user_starts = [
        index
        for index in range(boundary_start, len(path_entries))
        if _is_turn_start(path_entries[index])
    ]
    cut_index = max((index for index in user_starts if index <= threshold_index), default=boundary_start)
    if cut_index <= boundary_start:
        return None
    first_kept_id = path_entries[cut_index].get("id")
    if not isinstance(first_kept_id, str):
        raise ValueError("First kept compaction entry has no id")
    summarized = [message for group in entry_messages[boundary_start:cut_index] for message in group]
    retained = [message for group in entry_messages[cut_index:] for message in group]
    if not summarized:
        return None
    context = build_session_context(path_entries)
    tokens_before = estimate_context_tokens(context["messages"]).tokens
    return CompactionPreparation(
        first_kept_entry_id=first_kept_id,
        messages_to_summarize=summarized,
        retained_tail=retained,
        tokens_before=tokens_before,
        previous_summary=previous_summary,
    )


def _entry_messages(entry: SessionEntry) -> list[dict[str, Any]]:
    """取一条记录对应的运行时消息，过滤失败/被中止的 assistant 消息。"""
    return [
        message
        for message in session_entry_to_context_messages(entry)
        if not (message.get("role") == "assistant" and message.get("stopReason") in {"error", "aborted"})
    ]


def _is_turn_start(entry: SessionEntry) -> bool:
    """判断记录是否是一个回合的起点（用户消息或独立摘要/自定义消息）。"""
    if entry.get("type") in {"branch_summary", "custom_message"}:
        return True
    if entry.get("type") != "message" or not isinstance(entry.get("message"), dict):
        return False
    return entry["message"].get("role") == "user"

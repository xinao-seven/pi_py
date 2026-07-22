"""Conversation compaction preparation and provider-backed summarization."""

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
    enabled: bool = True
    reserve_tokens: int = 16384
    keep_recent_tokens: int = 20000

    def __post_init__(self) -> None:
        if self.reserve_tokens < 0 or self.keep_recent_tokens < 0:
            raise ValueError("Compaction token settings must not be negative")


@dataclass(frozen=True, slots=True)
class CompactionPreparation:
    first_kept_entry_id: str
    messages_to_summarize: list[dict[str, Any]]
    retained_tail: list[dict[str, Any]]
    tokens_before: int
    previous_summary: str | None = None


@dataclass(frozen=True, slots=True)
class CompactionSummary:
    text: str
    usage: dict[str, Any] | None = None


class CompactionSummarizer(Protocol):
    async def summarize(
        self,
        messages: list[dict[str, Any]],
        *,
        previous_summary: str | None = None,
        custom_instructions: str | None = None,
    ) -> CompactionSummary: ...


class ProviderCompactionSummarizer:
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
    return settings.enabled and context_window > 0 and context_tokens > context_window - settings.reserve_tokens


def is_context_overflow(message: dict[str, Any], context_window: int = 0) -> bool:
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
    if not path_entries or path_entries[-1].get("type") == "compaction":
        return None
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
    return [
        message
        for message in session_entry_to_context_messages(entry)
        if not (message.get("role") == "assistant" and message.get("stopReason") in {"error", "aborted"})
    ]


def _is_turn_start(entry: SessionEntry) -> bool:
    if entry.get("type") in {"branch_summary", "custom_message"}:
        return True
    if entry.get("type") != "message" or not isinstance(entry.get("message"), dict):
        return False
    return entry["message"].get("role") == "user"

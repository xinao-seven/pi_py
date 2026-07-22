"""Provider-neutral streaming protocol owned by the pi_ai layer."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Literal, NotRequired, Protocol, TypedDict


class ProviderEvent(TypedDict, total=False):
    """Stable events consumed by :mod:`pi_agent` after provider normalization."""

    type: Literal["text_delta", "thinking_delta", "tool_call_start", "tool_call_delta", "done"]
    text: NotRequired[str]
    id: NotRequired[str]
    name: NotRequired[str]
    arguments: NotRequired[dict[str, Any] | str]
    stop_reason: NotRequired[str]
    usage: NotRequired[dict[str, Any]]
    error: NotRequired[str]


class LLMProvider(Protocol):
    name: str

    def stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        thinking_level: str,
        system_prompt: str,
    ) -> AsyncIterator[ProviderEvent]: ...

    def count_tokens(self, messages: list[dict[str, Any]], model: str) -> int: ...

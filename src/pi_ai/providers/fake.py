"""Deterministic offline provider used by Agent integration tests."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable
from copy import deepcopy
from typing import Any

from pi_ai.providers.base import ProviderEvent


class FakeProvider:
    name = "fake"

    def __init__(self, scripted_turns: Iterable[Iterable[ProviderEvent]]) -> None:
        self._turns = [list(turn) for turn in scripted_turns]
        self.requests: list[dict[str, Any]] = []

    async def stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        thinking_level: str,
        system_prompt: str,
    ) -> AsyncIterator[ProviderEvent]:
        self.requests.append({
            "model": model,
            "messages": deepcopy(messages),
            "tools": deepcopy(tools),
            "thinkingLevel": thinking_level,
            "systemPrompt": system_prompt,
        })
        if not self._turns:
            raise RuntimeError("FakeProvider has no scripted turn remaining")
        for event in self._turns.pop(0):
            if event.get("type") == "delay":
                await asyncio.sleep(float(event.get("seconds", 0)))
                continue
            yield deepcopy(event)

    def count_tokens(self, messages: list[dict[str, Any]], model: str) -> int:
        del model
        return max(1, len(str(messages)) // 4)

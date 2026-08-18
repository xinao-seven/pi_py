"""Deterministic offline provider used by Agent integration tests.

中文说明：离线确定性 Provider，供 Agent 集成测试使用，不访问网络。
按预设“剧本”逐轮返回事件，并可记录每次请求便于断言。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterable
from copy import deepcopy
from typing import Any

from pi_ai.providers.base import ProviderEvent


class FakeProvider:
    name = "fake"

    def __init__(self, scripted_turns: Iterable[Iterable[ProviderEvent]]) -> None:
        # scripted_turns：按轮次预设的事件序列，每次 stream 消费一轮
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
        # 记录本次请求的完整入参，测试可据此断言 Agent 是否正确传参
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
                # 支持 delay 事件：模拟真实网络耗时，便于测试取消/超时路径
                await asyncio.sleep(float(event.get("seconds", 0)))
                continue
            yield deepcopy(event)

    def count_tokens(self, messages: list[dict[str, Any]], model: str) -> int:
        # 简化实现：按消息序列化长度估算，保证测试可重复
        del model
        return max(1, len(str(messages)) // 4)

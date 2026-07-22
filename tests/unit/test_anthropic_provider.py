from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from typing import Any

from pi_ai.providers.anthropic import AnthropicProvider


class FakeTransport:
    def __init__(self, packets: list[dict[str, Any]]) -> None:
        self.packets = packets
        self.request: dict[str, Any] | None = None

    async def stream_sse(
        self, *, url: str, headers: Mapping[str, str], json_body: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        self.request = {"url": url, "headers": dict(headers), "json": json_body}
        for packet in self.packets:
            yield packet


def test_anthropic_maps_messages_tools_and_stream_events() -> None:
    transport = FakeTransport(
        [
            {"type": "message_start", "message": {"usage": {"input_tokens": 12, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hello"}},
            {
                "type": "content_block_start",
                "index": 1,
                "content_block": {"type": "tool_use", "id": "call-1", "name": "read", "input": {}},
            },
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": '{"path":"a.txt"}'},
            },
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 5}},
        ]
    )
    provider = AnthropicProvider("secret", transport=transport)
    messages = [
        {"role": "user", "content": "inspect"},
        {
            "role": "assistant",
            "content": [{"type": "toolCall", "id": "old", "name": "read", "arguments": {"path": "b"}}],
        },
        {
            "role": "toolResult",
            "toolCallId": "old",
            "toolName": "read",
            "content": [{"type": "text", "text": "result"}],
            "isError": False,
        },
    ]
    async def collect() -> list[dict[str, Any]]:
        return [
            event
            async for event in provider.stream(
                model="claude-test",
                messages=messages,
                tools=[{"name": "read", "description": "Read", "input_schema": {"type": "object"}}],
                thinking_level="medium",
                system_prompt="Be concise",
            )
        ]

    events = asyncio.run(collect())

    assert [event["type"] for event in events] == [
        "text_delta",
        "tool_call_start",
        "tool_call_delta",
        "done",
    ]
    assert events[-1]["stop_reason"] == "toolUse"
    assert events[-1]["usage"] == {
        "input": 12,
        "output": 5,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 17,
    }
    assert transport.request is not None
    body = transport.request["json"]
    assert transport.request["url"].endswith("/v1/messages")
    assert body["system"] == "Be concise"
    assert body["thinking"] == {"type": "enabled", "budget_tokens": 4096}
    assert body["tools"][0]["input_schema"] == {"type": "object"}
    assert body["messages"][1]["content"][0]["type"] == "tool_use"
    assert body["messages"][2]["content"][0]["type"] == "tool_result"


def test_anthropic_normalizes_provider_error() -> None:
    provider = AnthropicProvider(
        "secret", transport=FakeTransport([{"type": "error", "error": {"message": "overloaded"}}])
    )
    async def collect() -> list[dict[str, Any]]:
        return [
            event
            async for event in provider.stream(
                model="claude-test", messages=[], tools=[], thinking_level="off", system_prompt=""
            )
        ]

    events = asyncio.run(collect())
    assert events == [
        {
            "type": "done",
            "stop_reason": "error",
            "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0},
            "error": "overloaded",
        }
    ]

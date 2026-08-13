from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from typing import Any

from pi_ai.providers.openai_compatible import OpenAICompatibleProvider


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


def test_openai_compatible_maps_request_and_interleaved_stream() -> None:
    transport = FakeTransport(
        [
            {"choices": [{"delta": {"reasoning_content": "think"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": "answer"}, "finish_reason": None}]},
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {"index": 0, "id": "call-1", "function": {"name": "read", "arguments": '{"path"'}}
                            ]
                        },
                        "finish_reason": None,
                    }
                ]
            },
            {
                "choices": [
                    {
                        "delta": {"tool_calls": [{"index": 0, "function": {"arguments": ':"a.txt"}'}}]},
                        "finish_reason": "tool_calls",
                    }
                ]
            },
            {
                "choices": [],
                "usage": {
                    "prompt_tokens": 20,
                    "completion_tokens": 8,
                    "total_tokens": 28,
                    "completion_tokens_details": {"reasoning_tokens": 3},
                },
            },
        ]
    )
    provider = OpenAICompatibleProvider("token", base_url="http://localhost:8000/v1", transport=transport)
    async def collect() -> list[dict[str, Any]]:
        return [
            event
            async for event in provider.stream(
                model="local-model",
                messages=[
                    {"role": "user", "content": [{"type": "image", "mimeType": "image/png", "data": "abc"}]},
                    {
                        "role": "assistant",
                        "content": [{"type": "toolCall", "id": "old", "name": "read", "arguments": {"path": "x"}}],
                    },
                    {
                        "role": "toolResult",
                        "toolCallId": "old",
                        "toolName": "read",
                        "content": [{"type": "text", "text": "ok"}],
                        "isError": False,
                    },
                ],
                tools=[{"name": "read", "description": "Read", "input_schema": {"type": "object"}}],
                thinking_level="xhigh",
                system_prompt="system",
            )
        ]

    events = asyncio.run(collect())

    assert [event["type"] for event in events] == [
        "thinking_delta",
        "text_delta",
        "tool_call_start",
        "tool_call_delta",
        "tool_call_delta",
        "done",
    ]
    assert events[-1]["stop_reason"] == "toolUse"
    assert events[-1]["usage"]["reasoning"] == 3
    assert transport.request is not None
    body = transport.request["json"]
    assert transport.request["url"] == "http://localhost:8000/v1/chat/completions"
    assert body["messages"][0] == {"role": "system", "content": "system"}
    assert body["messages"][1]["content"][0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert body["messages"][2]["tool_calls"][0]["function"]["arguments"] == '{"path": "x"}'
    assert body["messages"][3]["role"] == "tool"
    assert body["tools"][0]["function"]["parameters"] == {"type": "object"}
    assert body["reasoning_effort"] == "high"


def test_openai_stream_without_finish_reason_becomes_error() -> None:
    provider = OpenAICompatibleProvider(
        "token", transport=FakeTransport([{"choices": [{"delta": {"content": "partial"}}]}])
    )
    async def collect() -> list[dict[str, Any]]:
        return [
            event
            async for event in provider.stream(
                model="model", messages=[], tools=[], thinking_level="off", system_prompt=""
            )
        ]

    events = asyncio.run(collect())
    assert events[-1]["stop_reason"] == "error"
    assert events[-1]["error"] == "Stream ended without finish_reason"

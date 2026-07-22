"""OpenAI Chat Completions compatible streaming adapter."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from pi_ai.providers.base import ProviderEvent
from pi_ai.providers.transport import HttpxSSETransport, SSETransport

_STOP_REASONS = {"stop": "stop", "length": "length", "tool_calls": "toolUse"}


class OpenAICompatibleProvider:
    name = "openai-compatible"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://api.openai.com/v1",
        max_tokens: int | None = None,
        extra_headers: dict[str, str] | None = None,
        transport: SSETransport | None = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.max_tokens = max_tokens
        self.extra_headers = extra_headers or {}
        self.transport = transport or HttpxSSETransport()

    def build_request(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        thinking_level: str,
        system_prompt: str,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": model,
            "messages": _convert_messages(messages, system_prompt),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if self.max_tokens is not None:
            body["max_tokens"] = self.max_tokens
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool.get("description", ""),
                        "parameters": tool.get("input_schema", tool.get("parameters", {"type": "object"})),
                    },
                }
                for tool in tools
            ]
        if thinking_level != "off":
            body["reasoning_effort"] = "high" if thinking_level in {"xhigh", "max"} else thinking_level
        return body

    async def stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        thinking_level: str,
        system_prompt: str,
    ):
        body = self.build_request(
            model=model,
            messages=messages,
            tools=tools,
            thinking_level=thinking_level,
            system_prompt=system_prompt,
        )
        headers = {"authorization": f"Bearer {self.api_key}", "content-type": "application/json", **self.extra_headers}
        usage = _empty_usage()
        tool_ids: dict[int, str] = {}
        stop_reason: str | None = None
        error: str | None = None
        try:
            async for packet in self.transport.stream_sse(
                url=f"{self.base_url}/chat/completions", headers=headers, json_body=body
            ):
                if packet.get("error"):
                    raw_error = packet["error"]
                    error = raw_error.get("message", str(raw_error)) if isinstance(raw_error, dict) else str(raw_error)
                    break
                _update_openai_usage(usage, packet.get("usage"))
                choices = packet.get("choices", [])
                if not choices:
                    continue
                choice = choices[0]
                finish_reason = choice.get("finish_reason")
                if finish_reason:
                    stop_reason = _STOP_REASONS.get(str(finish_reason), "error")
                    if stop_reason == "error":
                        error = f"Provider finish_reason: {finish_reason}"
                delta = choice.get("delta") or {}
                content = delta.get("content")
                if isinstance(content, str) and content:
                    yield ProviderEvent(type="text_delta", text=content)
                for field in ("reasoning_content", "reasoning", "reasoning_text"):
                    reasoning = delta.get(field)
                    if isinstance(reasoning, str) and reasoning:
                        yield ProviderEvent(type="thinking_delta", text=reasoning)
                        break
                for tool_call in delta.get("tool_calls") or []:
                    index = int(tool_call.get("index", 0))
                    function = tool_call.get("function") or {}
                    if index not in tool_ids:
                        call_id = str(tool_call.get("id", f"tool-{index}"))
                        tool_ids[index] = call_id
                        yield ProviderEvent(
                            type="tool_call_start",
                            id=call_id,
                            name=str(function.get("name", "")),
                            arguments={},
                        )
                    arguments = function.get("arguments")
                    if isinstance(arguments, str) and arguments:
                        yield ProviderEvent(type="tool_call_delta", id=tool_ids[index], arguments=arguments)
            if error:
                yield _done("error", usage, error)
            elif stop_reason is None:
                yield _done("error", usage, "Stream ended without finish_reason")
            else:
                yield _done(stop_reason, usage)
        except asyncio.CancelledError:
            raise
        except Exception as exception:
            yield _done("error", usage, str(exception))

    def count_tokens(self, messages: list[dict[str, Any]], model: str) -> int:
        del model
        return max(1, len(json.dumps(messages, ensure_ascii=False)) // 4)


def _convert_messages(messages: list[dict[str, Any]], system_prompt: str) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    if system_prompt:
        converted.append({"role": "system", "content": system_prompt})
    for message in messages:
        role = message.get("role")
        if role == "user":
            content = message.get("content", "")
            if isinstance(content, str):
                converted.append({"role": "user", "content": content})
            else:
                converted.append({"role": "user", "content": _openai_content(content)})
        elif role == "assistant":
            text = "".join(
                str(block.get("text", "")) for block in message.get("content", []) if block.get("type") == "text"
            )
            assistant: dict[str, Any] = {"role": "assistant", "content": text or None}
            calls = [block for block in message.get("content", []) if block.get("type") == "toolCall"]
            if calls:
                assistant["tool_calls"] = [
                    {
                        "id": call.get("id", ""),
                        "type": "function",
                        "function": {
                            "name": call.get("name", ""),
                            "arguments": json.dumps(call.get("arguments", {}), ensure_ascii=False),
                        },
                    }
                    for call in calls
                ]
            if text or calls:
                converted.append(assistant)
        elif role == "toolResult":
            content = message.get("content", [])
            text = "\n".join(str(block.get("text", "")) for block in content if block.get("type") == "text")
            converted.append({"role": "tool", "tool_call_id": message.get("toolCallId", ""), "content": text})
            for block in content:
                if block.get("type") == "image":
                    converted.append({"role": "user", "content": _openai_content([block])})
    return converted


def _openai_content(content: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for block in content if isinstance(content, list) else []:
        if block.get("type") == "text":
            result.append({"type": "text", "text": str(block.get("text", ""))})
        elif block.get("type") == "image":
            result.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{block.get('mimeType', 'image/png')};base64,{block.get('data', '')}"},
                }
            )
    return result


def _empty_usage() -> dict[str, int]:
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}


def _update_openai_usage(usage: dict[str, int], raw: Any) -> None:
    if not isinstance(raw, dict):
        return
    usage["input"] = int(raw.get("prompt_tokens", usage["input"]))
    usage["output"] = int(raw.get("completion_tokens", usage["output"]))
    details = raw.get("completion_tokens_details", {})
    if isinstance(details, dict) and details.get("reasoning_tokens") is not None:
        usage["reasoning"] = int(details["reasoning_tokens"])
    prompt_details = raw.get("prompt_tokens_details", {})
    if isinstance(prompt_details, dict) and prompt_details.get("cached_tokens") is not None:
        usage["cacheRead"] = int(prompt_details["cached_tokens"])
    usage["totalTokens"] = int(raw.get("total_tokens", usage["input"] + usage["output"]))


def _done(stop_reason: str, usage: dict[str, int], error: str | None = None) -> ProviderEvent:
    event = ProviderEvent(type="done", stop_reason=stop_reason, usage=dict(usage))
    if error:
        event["error"] = error
    return event

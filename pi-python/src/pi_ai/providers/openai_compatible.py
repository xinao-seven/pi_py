"""OpenAI Chat Completions compatible streaming adapter.

中文说明：OpenAI Chat Completions 兼容流式适配器，同时也服务
一切使用该协议的服务（如各类中转/兼容端点）。负责统一消息 <-> OpenAI 格式转换，
并把 SSE 流事件归一化为 ProviderEvent。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from pi_ai.providers.base import ProviderEvent
from pi_ai.providers.transport import HttpxSSETransport, SSETransport

# OpenAI finish_reason -> 统一 stopReason 的映射
_STOP_REASONS = {"stop": "stop", "length": "length", "tool_calls": "toolUse"}


class OpenAICompatibleProvider:
    """OpenAI Chat Completions 兼容适配器：消息/工具/思考档位的请求组装与流事件归一化。"""
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
        """组装请求体：system 提示并入 messages、工具转 function 声明、
        stream_options 请求 usage；thinking_level 映射为 reasoning_effort。"""
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
        """主流程：逐包消费 SSE。usage 随时更新；choices[0].delta 里
        分别提取文本增量、推理增量（reasoning_content 等）与工具调用增量；
        finish_reason 映射为停止原因；流结束而没有 finish_reason 视为错误。
        """
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
                # 兼容各家厂商对推理字段的不同命名：只要命中一个就转发
                for field in ("reasoning_content", "reasoning", "reasoning_text"):
                    reasoning = delta.get(field)
                    if isinstance(reasoning, str) and reasoning:
                        yield ProviderEvent(type="thinking_delta", text=reasoning)
                        break
                for tool_call in delta.get("tool_calls") or []:
                    index = int(tool_call.get("index", 0))
                    function = tool_call.get("function") or {}
                    if index not in tool_ids:
                        # 同一 index 第一次出现：发出 tool_call_start，之后只发参数增量
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
    """统一消息 -> OpenAI 格式：system 前置，assistant 带 tool_calls，
    toolResult 转为 role=tool 的消息，图片以 data URL 形式追加为 user 消息。"""
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
    """统一 content block -> OpenAI content block（文本与 data URL 图片）。"""
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
    """创建全 0 的 usage 累计器。"""
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}


def _update_openai_usage(usage: dict[str, int], raw: Any) -> None:
    """把 OpenAI 的 usage 字段（prompt_tokens 等）归一到统一 usage 字典。"""
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
    """构造统一 done 事件：携带停止原因、usage 快照，出错时附 error 信息。"""
    event = ProviderEvent(type="done", stop_reason=stop_reason, usage=dict(usage))
    if error:
        event["error"] = error
    return event

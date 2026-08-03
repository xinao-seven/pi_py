"""Anthropic Messages API adapter.

中文说明：Anthropic Messages API 适配器。负责两件事：
1) 把统一消息格式转换成 Anthropic 的请求体（build_request / _convert_messages）；
2) 把 Anthropic SSE 流事件归一化为统一的 ProviderEvent（stream）。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from pi_ai.providers.base import ProviderEvent
from pi_ai.providers.transport import HttpxSSETransport, SSETransport

# thinking 档位 -> Anthropic thinking budget_tokens 的映射
_THINKING_BUDGETS = {
    "minimal": 1024,
    "low": 2048,
    "medium": 4096,
    "high": 8192,
    "xhigh": 16384,
    "max": 32768,
}
# Anthropic 结束原因 -> 统一 stopReason 的映射
_STOP_REASONS = {"end_turn": "stop", "stop_sequence": "stop", "max_tokens": "length", "tool_use": "toolUse"}


class AnthropicProvider:
    """Anthropic Messages API 适配器：统一消息 <-> Anthropic 格式，SSE 事件归一化为 ProviderEvent。"""
    name = "anthropic"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://api.anthropic.com",
        max_tokens: int = 8192,
        api_version: str = "2023-06-01",
        transport: SSETransport | None = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.max_tokens = max_tokens
        self.api_version = api_version
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
        """组装 Anthropic 请求体：模型、转换后的消息、max_tokens、流式开关；
        有系统提示时写入 system，有工具时写入 tools，思考档位映射为 thinking 预算。"""
        body: dict[str, Any] = {
            "model": model,
            "messages": _convert_messages(messages),
            "max_tokens": self.max_tokens,
            "stream": True,
        }
        if system_prompt:
            body["system"] = system_prompt
        if tools:
            body["tools"] = [
                {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("input_schema", tool.get("parameters", {"type": "object"})),
                }
                for tool in tools
            ]
        budget = _THINKING_BUDGETS.get(thinking_level)
        if budget is not None:
            body["thinking"] = {"type": "enabled", "budget_tokens": budget}
            body["max_tokens"] = max(self.max_tokens, budget + 1024)
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
        """主流程：逐包消费 Anthropic SSE 流并转发为统一事件。
        message_start 记录 usage；content_block_start 标记工具调用开始；
        content_block_delta 转发文本/思考/工具参数增量；
        message_delta 记录结束原因；最后 yield done 事件。
        """
        body = self.build_request(
            model=model,
            messages=messages,
            tools=tools,
            thinking_level=thinking_level,
            system_prompt=system_prompt,
        )
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": self.api_version,
            "content-type": "application/json",
        }
        usage = _empty_usage()
        tool_blocks: dict[int, tuple[str, str]] = {}
        stop_reason = "stop"
        try:
            async for packet in self.transport.stream_sse(
                url=f"{self.base_url}/v1/messages", headers=headers, json_body=body
            ):
                packet_type = packet.get("type")
                if packet_type == "error":
                    # 厂商直接返回错误：产出 done(error) 并结束本轮
                    error = packet.get("error", {})
                    message = error.get("message", str(error)) if isinstance(error, dict) else str(error)
                    yield _done("error", usage, message)
                    return
                if packet_type == "message_start":
                    # 流开始：记录请求侧的 usage（输入 token 等）
                    raw_usage = packet.get("message", {}).get("usage", {})
                    _update_anthropic_usage(usage, raw_usage)
                elif packet_type == "content_block_start":
                    index = int(packet.get("index", 0))
                    block = packet.get("content_block", {})
                    if block.get("type") == "tool_use":
                        # 工具调用开始：记住 index -> (id, name)，后续参数增量按 index 回填
                        call_id, name = str(block.get("id", "")), str(block.get("name", ""))
                        tool_blocks[index] = (call_id, name)
                        yield ProviderEvent(
                            type="tool_call_start",
                            id=call_id,
                            name=name,
                            arguments=block.get("input", {}) if isinstance(block.get("input", {}), dict) else {},
                        )
                elif packet_type == "content_block_delta":
                    delta = packet.get("delta", {})
                    delta_type = delta.get("type")
                    if delta_type == "text_delta":
                        yield ProviderEvent(type="text_delta", text=str(delta.get("text", "")))
                    elif delta_type == "thinking_delta":
                        yield ProviderEvent(type="thinking_delta", text=str(delta.get("thinking", "")))
                    elif delta_type == "input_json_delta":
                        # 工具参数是流式 JSON 片段，按 index 找到对应工具 id 后转发
                        call_id, _ = tool_blocks.get(int(packet.get("index", 0)), ("", ""))
                        yield ProviderEvent(
                            type="tool_call_delta", id=call_id, arguments=str(delta.get("partial_json", ""))
                        )
                elif packet_type == "message_delta":
                    delta = packet.get("delta", {})
                    if delta.get("stop_reason"):
                        # 流结束：记录停止原因，并更新输出侧的 usage
                        stop_reason = _STOP_REASONS.get(str(delta["stop_reason"]), "error")
                    _update_anthropic_usage(usage, packet.get("usage", {}))
            error = None if stop_reason != "error" else "Unknown Anthropic stop reason"
            yield _done(stop_reason, usage, error)
        except asyncio.CancelledError:
            raise
        except Exception as exception:
            yield _done("error", usage, str(exception))

    def count_tokens(self, messages: list[dict[str, Any]], model: str) -> int:
        del model
        return max(1, len(json.dumps(messages, ensure_ascii=False)) // 4)


def _convert_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """统一消息 -> Anthropic 消息格式；相邻同角色消息合并为一个 content 列表。"""
    converted: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        blocks: list[dict[str, Any]] = []
        target_role = "user" if role in {"user", "toolResult"} else "assistant"
        if role == "user":
            content = message.get("content", "")
            if isinstance(content, str):
                blocks.append({"type": "text", "text": content})
            else:
                blocks.extend(_anthropic_content(content))
        elif role == "assistant":
            for block in message.get("content", []):
                if block.get("type") == "text" and block.get("text"):
                    blocks.append({"type": "text", "text": block["text"]})
                elif block.get("type") == "toolCall":
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": block.get("id", ""),
                            "name": block.get("name", ""),
                            "input": block.get("arguments", {}),
                        }
                    )
                elif block.get("type") == "thinking" and block.get("thinkingSignature"):
                    blocks.append(
                        {
                            "type": "thinking",
                            "thinking": block.get("thinking", ""),
                            "signature": block["thinkingSignature"],
                        }
                    )
        elif role == "toolResult":
            blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": message.get("toolCallId", ""),
                    "content": _anthropic_content(message.get("content", [])),
                    "is_error": bool(message.get("isError", False)),
                }
            )
        if not blocks:
            continue
        if converted and converted[-1]["role"] == target_role:
            converted[-1]["content"].extend(blocks)
        else:
            converted.append({"role": target_role, "content": blocks})
    return converted


def _anthropic_content(content: Any) -> list[dict[str, Any]]:
    """统一 content block -> Anthropic content block（文本与 base64 图片）。"""
    if not isinstance(content, list):
        return [{"type": "text", "text": str(content)}]
    result: list[dict[str, Any]] = []
    for block in content:
        if block.get("type") == "text":
            result.append({"type": "text", "text": str(block.get("text", ""))})
        elif block.get("type") == "image":
            result.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": block.get("mimeType", "image/png"),
                        "data": block.get("data", ""),
                    },
                }
            )
    return result


def _empty_usage() -> dict[str, int]:
    """创建全 0 的 usage 累计器。"""
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0}


def _update_anthropic_usage(usage: dict[str, int], raw: Any) -> None:
    """把 Anthropic 的 usage 字段名（input_tokens 等）归一到统一 usage 字典。"""
    if not isinstance(raw, dict):
        return
    mapping = {
        "input_tokens": "input",
        "output_tokens": "output",
        "cache_read_input_tokens": "cacheRead",
        "cache_creation_input_tokens": "cacheWrite",
    }
    for source, target in mapping.items():
        if raw.get(source) is not None:
            usage[target] = int(raw[source])
    details = raw.get("output_tokens_details", {})
    if isinstance(details, dict) and details.get("thinking_tokens") is not None:
        usage["reasoning"] = int(details["thinking_tokens"])
    usage["totalTokens"] = usage["input"] + usage["output"] + usage["cacheRead"] + usage["cacheWrite"]


def _done(stop_reason: str, usage: dict[str, int], error: str | None = None) -> ProviderEvent:
    """构造统一 done 事件：携带停止原因、usage 快照，出错时附 error 信息。"""
    event = ProviderEvent(type="done", stop_reason=stop_reason, usage=dict(usage))
    if error:
        event["error"] = error
    return event

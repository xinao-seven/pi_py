"""Provider-neutral streaming protocol owned by the pi_ai layer.

中文说明：定义与厂商无关的流式协议。各家 Provider 把原始 SSE 流
归一化为 ProviderEvent 事件，上层（pi_agent）只消费这些事件，不感知厂商差异。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Literal, NotRequired, Protocol, TypedDict


class ProviderEvent(TypedDict, total=False):
    """Stable events consumed by :mod:`pi_agent` after provider normalization.

    中文说明：Provider 归一化后的事件协议。type 取值：
    text_delta 文本增量、thinking_delta 思考增量、tool_call_start 工具调用开始、
    tool_call_delta 工具参数增量、done 单轮结束（携带 stop_reason 与 usage）。
    """

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

    # 流式对话协议：所有 Provider 必须实现 stream 与 count_tokens
    def stream(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        thinking_level: str,
        system_prompt: str,
    ) -> AsyncIterator[ProviderEvent]: ...
    # 参数说明：model 模型 id；messages 统一消息列表；tools 工具声明；
    # thinking_level 思考档位；system_prompt 系统提示

    def count_tokens(self, messages: list[dict[str, Any]], model: str) -> int: ...
    # 估算一组消息的 token 数，供上下文窗口占用判断使用

"""DeepSeek V4 adapter built on its OpenAI-compatible Chat Completions API.

中文说明：DeepSeek V4 适配器，复用 OpenAI 兼容的 Chat Completions 协议，
并针对 DeepSeek 的思考开关做定制：thinking_level=off 时显式禁用思考，
否则启用思考并把档位映射为 reasoning_effort。
"""

from __future__ import annotations

from typing import Any

from pi_ai.providers.openai_compatible import OpenAICompatibleProvider
from pi_ai.providers.transport import SSETransport


DEEPSEEK_BASE_URL = "https://api.deepseek.com"


class DeepSeekProvider(OpenAICompatibleProvider):
    """DeepSeek V4 Provider：在 OpenAI 兼容请求基础上覆盖 thinking 相关字段。"""
    name = "deepseek"

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEEPSEEK_BASE_URL,
        max_tokens: int | None = None,
        transport: SSETransport | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            max_tokens=max_tokens,
            transport=transport,
        )

    def build_request(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        thinking_level: str,
        system_prompt: str,
    ) -> dict[str, Any]:
        """在父类请求体基础上设置 DeepSeek 的 thinking 开关与 reasoning_effort。"""
        body = super().build_request(
            model=model,
            messages=messages,
            tools=tools,
            thinking_level=thinking_level,
            system_prompt=system_prompt,
        )
        if thinking_level == "off":
            body["thinking"] = {"type": "disabled"}
            body.pop("reasoning_effort", None)
        else:
            body["thinking"] = {"type": "enabled"}
            body["reasoning_effort"] = _reasoning_effort(thinking_level)
        return body


def _reasoning_effort(thinking_level: str) -> str:
    """思考档位 -> reasoning_effort 的映射：minimal/low 归 low，xhigh/max 归 max，其余归 high。"""
    if thinking_level in {"xhigh", "max"}:
        return "max"
    if thinking_level in {"minimal", "low"}:
        return "low"
    return "high"

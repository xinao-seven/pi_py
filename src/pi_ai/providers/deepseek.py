"""DeepSeek V4 adapter built on its OpenAI-compatible Chat Completions API."""

from __future__ import annotations

from typing import Any

from pi_ai.providers.openai_compatible import OpenAICompatibleProvider
from pi_ai.providers.transport import SSETransport


DEEPSEEK_BASE_URL = "https://api.deepseek.com"


class DeepSeekProvider(OpenAICompatibleProvider):
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
    if thinking_level in {"xhigh", "max"}:
        return "max"
    if thinking_level in {"minimal", "low"}:
        return "low"
    return "high"

"""Small provider registry used by CLI, API, and tests.

中文说明：小型 Provider 注册表，供命令行、API 与测试按名称获取 Provider 实例。
"""

from __future__ import annotations

from collections.abc import Iterable

from pi_ai.providers.anthropic import AnthropicProvider
from pi_ai.providers.base import LLMProvider
from pi_ai.providers.deepseek import DeepSeekProvider
from pi_ai.providers.openai_compatible import OpenAICompatibleProvider


class ProviderRegistry:
    """名称 -> Provider 实例 的映射，支持注册、按名获取与枚举。"""
    def __init__(self, providers: Iterable[LLMProvider] = ()) -> None:
        self._providers: dict[str, LLMProvider] = {}
        for provider in providers:
            self.register(provider)

    def register(self, provider: LLMProvider, *, name: str | None = None) -> None:
        key = name or provider.name
        if not key:
            raise ValueError("Provider name must not be empty")
        self._providers[key] = provider

    def get(self, name: str) -> LLMProvider:
        try:
            return self._providers[name]
        except KeyError as exception:
            available = ", ".join(sorted(self._providers)) or "none"
            raise KeyError(f"Unknown provider {name!r}; available: {available}") from exception

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._providers))


def create_provider(
    provider: str,
    *,
    api_key: str,
    base_url: str | None = None,
) -> LLMProvider:
    """Create a built-in provider without reading environment variables.

    中文说明：按字符串创建内置 Provider 的工厂函数，不读取环境变量。
    支持 anthropic / openai / openai-compatible / deepseek。
    """

    if provider == "anthropic":
        kwargs = {"base_url": base_url} if base_url else {}
        return AnthropicProvider(api_key, **kwargs)
    if provider in {"openai", "openai-compatible"}:
        kwargs = {"base_url": base_url} if base_url else {}
        return OpenAICompatibleProvider(api_key, **kwargs)
    if provider == "deepseek":
        kwargs = {"base_url": base_url} if base_url else {}
        return DeepSeekProvider(api_key, **kwargs)
    raise ValueError(f"Unsupported provider: {provider}")

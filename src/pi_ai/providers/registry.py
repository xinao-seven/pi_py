"""Small provider registry used by CLI, API, and tests."""

from __future__ import annotations

from collections.abc import Iterable

from pi_ai.providers.anthropic import AnthropicProvider
from pi_ai.providers.base import LLMProvider
from pi_ai.providers.deepseek import DeepSeekProvider
from pi_ai.providers.openai_compatible import OpenAICompatibleProvider


class ProviderRegistry:
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
    """Create a built-in provider without reading environment variables."""

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

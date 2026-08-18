import pytest

from pi_ai.providers import (
    AnthropicProvider,
    DeepSeekProvider,
    OpenAICompatibleProvider,
    ProviderRegistry,
    create_provider,
)


def test_registry_uses_provider_names_and_reports_available_names() -> None:
    anthropic = AnthropicProvider("key")
    openai = OpenAICompatibleProvider("key")
    registry = ProviderRegistry([anthropic, openai])

    assert registry.names() == ("anthropic", "openai-compatible")
    assert registry.get("anthropic") is anthropic
    with pytest.raises(KeyError, match="available: anthropic, openai-compatible"):
        registry.get("missing")


def test_create_provider_has_explicit_configuration_boundary() -> None:
    provider = create_provider("openai-compatible", api_key="key", base_url="http://localhost:1234/v1")
    assert isinstance(provider, OpenAICompatibleProvider)
    assert provider.base_url == "http://localhost:1234/v1"

    deepseek = create_provider("deepseek", api_key="deepseek-key")
    assert isinstance(deepseek, DeepSeekProvider)
    assert deepseek.name == "deepseek"
    assert deepseek.base_url == "https://api.deepseek.com"

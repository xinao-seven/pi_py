from pathlib import Path

import httpx
import pytest

from server.config import ServerSettings
from server.main import create_app
from server.services.model_config import ModelConfigService
from pi_ai.providers import DeepSeekProvider


@pytest.mark.asyncio
async def test_models_config_round_trip_and_catalog(tmp_path: Path) -> None:
    app = create_app(
        ServerSettings(
            agent_dir=tmp_path / "agent",
            sessions_dir=tmp_path / "sessions",
            default_provider="custom",
            default_model="fallback-model",
        )
    )
    transport = httpx.ASGITransport(app=app)
    config = {
        "providers": {
            "custom": {
                "api": "openai-completions",
                "baseUrl": "https://example.invalid/v1",
                "apiKey": "$CUSTOM_API_KEY",
                "models": [
                    {
                        "id": "custom-model",
                        "name": "Custom Model",
                        "contextWindow": 200000,
                        "reasoning": False,
                    }
                ],
            }
        }
    }

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        saved = await client.put("/api/models-config", json=config)
        loaded = await client.get("/api/models-config")
        catalog = await client.get("/api/models")

    assert saved.json() == {"success": True}
    assert loaded.json() == config
    assert catalog.json()["models"]["custom:custom-model"] == "Custom Model"
    assert catalog.json()["defaultModel"] == {
        "provider": "custom",
        "modelId": "fallback-model",
    }
    custom_model = next(
        model
        for model in catalog.json()["modelList"]
        if model["id"] == "custom-model"
    )
    assert custom_model["contextWindow"] == 200000
    assert catalog.json()["thinkingLevels"]["custom:custom-model"] == ["off"]


@pytest.mark.asyncio
async def test_models_config_rejects_inline_api_keys(tmp_path: Path) -> None:
    app = create_app(
        ServerSettings(agent_dir=tmp_path / "agent", sessions_dir=tmp_path / "sessions")
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.put(
            "/api/models-config",
            json={"providers": {"unsafe": {"apiKey": "sk-secret"}}},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_models_config"
    assert not (tmp_path / "agent" / "models.json").exists()


def test_provider_resolves_api_key_from_secrets_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    (agent_dir / "secrets.env").write_text(
        "CUSTOM_API_KEY=file-secret\n",
        encoding="utf-8",
    )
    service = ModelConfigService(agent_dir)
    service.write(
        {
            "providers": {
                "custom": {
                    "api": "openai-completions",
                    "apiKey": "$CUSTOM_API_KEY",
                }
            }
        }
    )
    captured: dict[str, str | None] = {}

    class FakeProvider:
        name = "custom"

    def fake_create_provider(
        name: str,
        *,
        api_key: str,
        base_url: str | None = None,
    ) -> FakeProvider:
        captured.update(name=name, api_key=api_key, base_url=base_url)
        return FakeProvider()

    monkeypatch.delenv("CUSTOM_API_KEY", raising=False)
    monkeypatch.setattr(
        "server.services.model_config.create_provider",
        fake_create_provider,
    )

    provider = service.resolve_provider("custom")

    assert provider.name == "custom"
    assert captured == {
        "name": "openai-compatible",
        "api_key": "file-secret",
        "base_url": None,
    }


def test_deepseek_config_uses_native_adapter_and_secret(tmp_path: Path) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    (agent_dir / "secrets.env").write_text(
        "DEEPSEEK_API_KEY=deepseek-secret\n",
        encoding="utf-8",
    )
    service = ModelConfigService(agent_dir)
    service.write(
        {
            "providers": {
                "deepseek": {
                    "api": "deepseek-chat-completions",
                    "baseUrl": "https://api.deepseek.com",
                    "apiKey": "$DEEPSEEK_API_KEY",
                    "models": [{"id": "deepseek-v4-flash"}],
                }
            }
        }
    )

    provider = service.resolve_provider("deepseek")

    assert isinstance(provider, DeepSeekProvider)
    assert provider.api_key == "deepseek-secret"
    assert provider.base_url == "https://api.deepseek.com"

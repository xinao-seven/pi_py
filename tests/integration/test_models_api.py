from pathlib import Path
import json

import httpx
import pytest

from server.config import ServerSettings
from server.main import create_app
from server.services.model_config import ModelConfigService
from server.services.pi_config import PiConfig
from pi_ai.providers import DeepSeekProvider


def _settings(tmp_path: Path, **kwargs) -> ServerSettings:
    """默认把所有可写目录隔离到 tmp_path，避免触碰真实的 ~/.pi。"""
    return ServerSettings(
        agent_dir=tmp_path / "agent",
        sessions_dir=tmp_path / "sessions",
        own_config_dir=tmp_path / "agent-python",
        **kwargs,
    )


@pytest.mark.asyncio
async def test_models_config_round_trip_and_catalog(tmp_path: Path) -> None:
    app = create_app(
        _settings(
            tmp_path,
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
    # 写操作只落在 pi.py 自身目录，原版 pi 的 models.json 不会被创建
    assert (tmp_path / "agent-python" / "models.json").is_file()
    assert not (tmp_path / "agent" / "models.json").exists()


@pytest.mark.asyncio
async def test_models_config_rejects_inline_api_keys(tmp_path: Path) -> None:
    app = create_app(_settings(tmp_path))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.put(
            "/api/models-config",
            json={"providers": {"unsafe": {"apiKey": "sk-secret"}}},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_models_config"
    assert not (tmp_path / "agent-python" / "models.json").exists()
    assert not (tmp_path / "agent" / "models.json").exists()


def test_provider_resolves_api_key_from_auth_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    (agent_dir / "auth.json").write_text(
        '{"custom": {"type": "api_key", "key": "sk-auth-secret"}}\n',
        encoding="utf-8",
    )
    service = ModelConfigService(PiConfig(agent_dir), tmp_path / "agent-python")
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
        "api_key": "sk-auth-secret",
        "base_url": None,
    }


def test_deepseek_config_uses_native_adapter_and_auth_key(tmp_path: Path) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    (agent_dir / "auth.json").write_text(
        '{"deepseek": {"type": "api_key", "key": "sk-deepseek-secret"}}\n',
        encoding="utf-8",
    )
    service = ModelConfigService(PiConfig(agent_dir), tmp_path / "agent-python")
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
    assert provider.api_key == "sk-deepseek-secret"
    assert provider.base_url == "https://api.deepseek.com"


def test_pi_models_store_is_merged_read_only_into_catalog(tmp_path: Path) -> None:
    """原版 pi 的 models-store.json / models.json 只读合并进目录，绝不改写。"""
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    store = {
        "deepseek": {
            "models": [
                {
                    "id": "deepseek-v4-flash",
                    "name": "DeepSeek V4 Flash",
                    "contextWindow": 1_000_000,
                    "reasoning": True,
                    "thinkingLevelMap": {"high": "high", "max": "max"},
                }
            ]
        }
    }
    overrides = {
        "providers": {
            "deepseek": {
                "api": "openai-completions",
                "baseUrl": "https://api.deepseek.com",
            }
        }
    }
    (agent_dir / "models-store.json").write_text(
        json.dumps(store),
        encoding="utf-8",
    )
    (agent_dir / "models.json").write_text(
        json.dumps(overrides),
        encoding="utf-8",
    )
    service = ModelConfigService(PiConfig(agent_dir), tmp_path / "agent-python")

    catalog = service.catalog(
        default_provider="deepseek",
        default_model="deepseek-v4-flash",
    )

    assert catalog["models"]["deepseek:deepseek-v4-flash"] == "DeepSeek V4 Flash"
    assert catalog["modelList"][0]["contextWindow"] == 1_000_000
    assert catalog["thinkingLevelMaps"]["deepseek:deepseek-v4-flash"] == {
        "high": "high",
        "max": "max",
    }
    # 原版 pi 的文件保持原样
    assert (agent_dir / "models.json").read_text(encoding="utf-8") == (
        json.dumps(overrides)
    )
    assert (agent_dir / "models-store.json").read_text(encoding="utf-8") == (
        json.dumps(store)
    )
    assert not (tmp_path / "agent-python").exists()

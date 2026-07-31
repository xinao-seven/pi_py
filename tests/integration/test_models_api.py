from pathlib import Path

import httpx
import pytest

from server.config import ServerSettings
from server.main import create_app


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

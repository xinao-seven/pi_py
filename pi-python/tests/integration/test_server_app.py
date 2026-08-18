from pathlib import Path

import httpx
import pytest

from server.config import ServerSettings
from server.main import create_app


@pytest.mark.asyncio
async def test_application_factory_exposes_health_and_openapi(tmp_path: Path) -> None:
    app = create_app(ServerSettings(sessions_dir=tmp_path, own_config_dir=tmp_path / "agent-python"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        health = await client.get("/api/health")
        schema = await client.get("/api/openapi.json")

    assert health.json() == {"status": "ok"}
    assert schema.status_code == 200
    assert schema.json()["info"]["title"] == "Pi Agent Python Server"


@pytest.mark.asyncio
async def test_cors_preflight_uses_configured_origin(tmp_path: Path) -> None:
    settings = ServerSettings(sessions_dir=tmp_path, cors_origins=("http://ui.test",), own_config_dir=tmp_path / "agent-python")
    app = create_app(settings)
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.options(
            "/api/health",
            headers={
                "Origin": "http://ui.test",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://ui.test"


@pytest.mark.asyncio
async def test_built_vue_frontend_is_served_without_shadowing_api(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<main>pi.py web</main>", encoding="utf-8")
    (assets / "app.js").write_text("console.log('pi')", encoding="utf-8")
    app = create_app(
        ServerSettings(sessions_dir=tmp_path / "sessions", web_dist_dir=dist, own_config_dir=tmp_path / "agent-python")
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        page = await client.get("/")
        asset = await client.get("/assets/app.js")
        health = await client.get("/api/health")

    assert page.status_code == 200
    assert "pi.py web" in page.text
    assert asset.text == "console.log('pi')"
    assert health.json() == {"status": "ok"}


def test_settings_defaults_point_to_pi_agent_dir_and_own_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_dir = tmp_path / "agent"
    monkeypatch.setenv("PI_SERVER_AGENT_DIR", str(agent_dir))

    settings = ServerSettings.from_env()

    # 会话/配置默认全部指向原版 pi 的位置；pi.py 自身配置与 pi 隔离
    assert settings.agent_dir == agent_dir
    assert settings.sessions_dir == agent_dir / "sessions"
    assert settings.own_config_dir == agent_dir.parent / "agent-python"
    # 密钥/默认设置不再从环境变量读取
    assert not hasattr(settings, "secrets_file")
    monkeypatch.delenv("PI_SERVER_DEFAULT_PROVIDER", raising=False)
    assert settings.default_provider == "anthropic"


def test_pi_settings_json_override_defaults(tmp_path: Path) -> None:
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    (agent_dir / "settings.json").write_text(
        '{"defaultProvider": "deepseek", "defaultModel": "deepseek-v4-flash",'
        ' "defaultThinkingLevel": "high"}\n',
        encoding="utf-8",
    )
    app = create_app(ServerSettings(agent_dir=agent_dir, sessions_dir=tmp_path / "sessions", own_config_dir=tmp_path / "agent-python"))

    settings = app.state.settings
    assert settings.default_provider == "deepseek"
    assert settings.default_model == "deepseek-v4-flash"
    assert settings.default_thinking_level == "high"

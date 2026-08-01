from pathlib import Path

import httpx
import pytest

from server.config import ServerSettings
from server.main import create_app


@pytest.mark.asyncio
async def test_application_factory_exposes_health_and_openapi(tmp_path: Path) -> None:
    app = create_app(ServerSettings(sessions_dir=tmp_path))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        health = await client.get("/api/health")
        schema = await client.get("/api/openapi.json")

    assert health.json() == {"status": "ok"}
    assert schema.status_code == 200
    assert schema.json()["info"]["title"] == "Pi Agent Python Server"


@pytest.mark.asyncio
async def test_cors_preflight_uses_configured_origin(tmp_path: Path) -> None:
    settings = ServerSettings(sessions_dir=tmp_path, cors_origins=("http://ui.test",))
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
        ServerSettings(sessions_dir=tmp_path / "sessions", web_dist_dir=dist)
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


def test_settings_use_agent_local_or_explicit_secrets_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_dir = tmp_path / "agent"
    monkeypatch.setenv("PI_SERVER_AGENT_DIR", str(agent_dir))
    monkeypatch.delenv("PI_SERVER_SECRETS_FILE", raising=False)

    default_settings = ServerSettings.from_env()
    assert default_settings.secrets_file == agent_dir / "secrets.env"

    explicit = tmp_path / "private" / "provider.env"
    monkeypatch.setenv("PI_SERVER_SECRETS_FILE", str(explicit))
    assert ServerSettings.from_env().secrets_file == explicit

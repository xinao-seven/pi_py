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

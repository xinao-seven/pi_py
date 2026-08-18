from pathlib import Path
from typing import Any

import httpx
import pytest

from pi_coding_agent import SessionManager
from server.config import ServerSettings
from server.main import create_app


def _assistant(text: str) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "provider": "fake",
        "model": "fake-model",
        "stopReason": "stop",
    }


def _create_session(root: Path, cwd: Path) -> SessionManager:
    manager = SessionManager.create(cwd, root / "project", session_id="web-session")
    manager.append_message({"role": "user", "content": "hello web"})
    manager.append_message(_assistant("hello user"))
    return manager


@pytest.mark.asyncio
async def test_list_and_get_session_return_web_context(tmp_path: Path) -> None:
    manager = _create_session(tmp_path / "sessions", tmp_path / "workspace")
    app = create_app(ServerSettings(sessions_dir=tmp_path / "sessions", own_config_dir=tmp_path / "agent-python"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        listing = await client.get("/api/sessions")
        detail = await client.get("/api/sessions/web-session")

    assert listing.status_code == 200
    assert listing.json()["sessions"][0]["firstMessage"] == "hello web"
    assert detail.status_code == 200
    body = detail.json()
    assert body["sessionId"] == "web-session"
    assert body["filePath"] == str(manager.session_file)
    assert body["leafId"] == manager.leaf_id
    assert [message["role"] for message in body["context"]["messages"]] == ["user", "assistant"]
    assert len(body["context"]["entryIds"]) == 2


@pytest.mark.asyncio
async def test_context_can_select_a_specific_leaf(tmp_path: Path) -> None:
    manager = _create_session(tmp_path / "sessions", tmp_path / "workspace")
    first_entry_id = manager.get_entries()[0]["id"]
    app = create_app(ServerSettings(sessions_dir=tmp_path / "sessions", own_config_dir=tmp_path / "agent-python"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            "/api/sessions/web-session/context",
            params={"leaf_id": first_entry_id},
        )

    assert response.status_code == 200
    assert [message["role"] for message in response.json()["messages"]] == ["user"]


@pytest.mark.asyncio
async def test_rename_persists_and_missing_session_uses_error_envelope(tmp_path: Path) -> None:
    _create_session(tmp_path / "sessions", tmp_path / "workspace")
    app = create_app(ServerSettings(sessions_dir=tmp_path / "sessions", own_config_dir=tmp_path / "agent-python"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        renamed = await client.patch(
            "/api/sessions/web-session",
            json={"name": "新的会话名"},
        )
        detail = await client.get("/api/sessions/web-session")
        missing = await client.get("/api/sessions/missing")

    assert renamed.json() == {"ok": True}
    assert detail.json()["info"]["name"] == "新的会话名"
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "session_not_found"


@pytest.mark.asyncio
async def test_list_marks_malformed_session_as_orphan_without_opening_it(tmp_path: Path) -> None:
    sessions_dir = tmp_path / "sessions"
    project_dir = sessions_dir / "project"
    project_dir.mkdir(parents=True)
    broken = project_dir / "broken.jsonl"
    broken.write_text("not-json\n", encoding="utf-8")
    app = create_app(ServerSettings(sessions_dir=sessions_dir, own_config_dir=tmp_path / "agent-python"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        listing = await client.get("/api/sessions")
        orphan = listing.json()["sessions"][0]
        detail = await client.get(f"/api/sessions/{orphan['id']}")

    assert orphan["orphaned"] is True
    assert orphan["path"] == str(broken.resolve())
    assert orphan["orphanReason"]
    assert detail.status_code == 404

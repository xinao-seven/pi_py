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
        "model": "fake",
        "stopReason": "stop",
    }


def _persist(manager: SessionManager, user: str, assistant: str) -> None:
    manager.append_message({"role": "user", "content": user})
    manager.append_message(_assistant(assistant))


@pytest.mark.asyncio
async def test_delete_reparents_direct_child_to_deleted_sessions_parent(tmp_path: Path) -> None:
    root = tmp_path / "sessions"
    directory = root / "project"
    grandparent = SessionManager.create(tmp_path, directory, session_id="grandparent")
    _persist(grandparent, "grand", "grand answer")
    parent = SessionManager.create(
        tmp_path,
        directory,
        session_id="parent",
        parent_session=str(grandparent.session_file),
    )
    _persist(parent, "parent", "parent answer")
    child = SessionManager.create(
        tmp_path,
        directory,
        session_id="child",
        parent_session=str(parent.session_file),
    )
    _persist(child, "child", "child answer")
    app = create_app(ServerSettings(sessions_dir=root))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.delete("/api/sessions/parent")
        missing = await client.get("/api/sessions/parent")

    assert response.json() == {"ok": True, "reparentedCount": 1}
    assert missing.status_code == 404
    assert parent.session_file is not None and not parent.session_file.exists()
    assert SessionManager.open(child.session_file).get_header()["parentSession"] == str(
        grandparent.session_file
    )


@pytest.mark.asyncio
async def test_merge_appends_bounded_custom_summary_to_target(tmp_path: Path) -> None:
    root = tmp_path / "sessions"
    directory = root / "project"
    target = SessionManager.create(tmp_path, directory, session_id="target")
    _persist(target, "shared request", "shared answer")
    source = SessionManager.fork_from(
        target.session_file,
        tmp_path,
        directory,
        session_id="source",
    )
    _persist(source, "source-only request", "source-only answer")
    app = create_app(ServerSettings(sessions_dir=root))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/sessions/target/merge",
            json={"sourceSessionId": "source"},
        )
        detail = await client.get("/api/sessions/target")

    assert response.status_code == 200
    assert response.json()["sourceUniqueEntryCount"] == 2
    assert response.json()["summarizedItemCount"] == 2
    merged = detail.json()["context"]["messages"][-1]
    assert merged["role"] == "custom"
    assert "source-only request" in merged["content"]
    target_entries = SessionManager.open(target.session_file).get_entries()
    assert target_entries[-1]["customType"] == "session_merge_summary"
    assert target_entries[-1]["details"]["sourceSessionId"] == "source"


@pytest.mark.asyncio
async def test_merge_rejects_self_and_source_without_unique_content(tmp_path: Path) -> None:
    root = tmp_path / "sessions"
    directory = root / "project"
    target = SessionManager.create(tmp_path, directory, session_id="target")
    _persist(target, "same", "same answer")
    source = SessionManager.fork_from(
        target.session_file,
        tmp_path,
        directory,
        session_id="source",
    )
    app = create_app(ServerSettings(sessions_dir=root))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        self_merge = await client.post(
            "/api/sessions/target/merge",
            json={"sourceSessionId": "target"},
        )
        empty_merge = await client.post(
            "/api/sessions/target/merge",
            json={"sourceSessionId": "source"},
        )

    assert self_merge.status_code == 400
    assert empty_merge.status_code == 409
    assert empty_merge.json()["error"]["code"] == "nothing_to_merge"

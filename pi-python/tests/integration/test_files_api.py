from pathlib import Path

import httpx
import pytest

from pi_coding_agent import SessionManager
from server.config import ServerSettings
from server.main import create_app


def _allow_workspace(sessions_root: Path, workspace: Path) -> None:
    manager = SessionManager.create(workspace, sessions_root / "project", session_id="files")
    manager.append_message({"role": "user", "content": "files"})
    manager.append_message(
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "ready"}],
            "provider": "fake",
            "model": "fake",
            "stopReason": "stop",
        }
    )


def _url(path: Path) -> str:
    return "/api/files/" + "/".join(part for part in path.as_posix().split("/") if part)


@pytest.mark.asyncio
async def test_list_and_read_only_within_session_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "src").mkdir()
    (workspace / "src" / "app.py").write_text("print('你好')\n", encoding="utf-8")
    (workspace / ".git").mkdir()
    (workspace / ".env").write_text("SECRET=value", encoding="utf-8")
    (workspace / "secrets.env").write_text("SECRET=value", encoding="utf-8")
    _allow_workspace(tmp_path / "sessions", workspace)
    app = create_app(ServerSettings(sessions_dir=tmp_path / "sessions", own_config_dir=tmp_path / "agent-python"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        listing = await client.get(
            _url(workspace),
            params={"type": "list", "root": str(workspace)},
        )
        preview = await client.get(
            _url(workspace / "src" / "app.py"),
            params={"type": "read", "root": str(workspace)},
        )

    assert [entry["name"] for entry in listing.json()["entries"]] == ["src"]
    assert preview.json() == {
        "content": "print('你好')\n",
        "language": "python",
        "size": (workspace / "src" / "app.py").stat().st_size,
    }


@pytest.mark.asyncio
async def test_file_api_rejects_unregistered_roots_traversal_and_secrets(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".env").write_text("SECRET=value", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    _allow_workspace(tmp_path / "sessions", workspace)
    app = create_app(ServerSettings(sessions_dir=tmp_path / "sessions", own_config_dir=tmp_path / "agent-python"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        unregistered = await client.get(
            _url(tmp_path),
            params={"type": "list", "root": str(tmp_path)},
        )
        traversal = await client.get(
            "/api/files/../outside.txt",
            params={"type": "read", "root": str(workspace)},
        )
        secret = await client.get(
            _url(workspace / ".env"),
            params={"type": "read", "root": str(workspace)},
        )

    assert unregistered.status_code == 403
    assert traversal.status_code in {403, 404}
    assert secret.status_code == 403
    assert secret.json()["error"]["code"] == "sensitive_file"


@pytest.mark.asyncio
async def test_text_size_limit_and_media_preview(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "large.txt").write_bytes(b"x" * (256 * 1024 + 1))
    image = workspace / "pixel.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n")
    _allow_workspace(tmp_path / "sessions", workspace)
    app = create_app(ServerSettings(sessions_dir=tmp_path / "sessions", own_config_dir=tmp_path / "agent-python"))
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        too_large = await client.get(
            _url(workspace / "large.txt"),
            params={"type": "read", "root": str(workspace)},
        )
        media = await client.get(
            _url(image),
            params={"type": "read", "root": str(workspace)},
        )

    assert too_large.status_code == 413
    assert media.status_code == 200
    assert media.headers["content-type"] == "image/png"
    assert media.content == b"\x89PNG\r\n\x1a\n"

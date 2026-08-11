from pathlib import Path

import httpx
import pytest

from server.config import ServerSettings
from server.main import create_app


@pytest.mark.asyncio
async def test_default_and_selected_workspaces_are_controlled_by_parent(tmp_path: Path) -> None:
    parent = tmp_path / "allowed"
    selected = parent / "project"
    selected.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    app = create_app(
        ServerSettings(
            agent_dir=tmp_path / "agent",
            sessions_dir=tmp_path / "sessions",
            own_config_dir=tmp_path / "agent-python",
            workspace_parent=parent,
        )
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        default = await client.post("/api/default-cwd")
        accepted = await client.post("/api/workspaces/select", json={"cwd": str(selected)})
        rejected = await client.post("/api/workspaces/select", json={"cwd": str(outside)})
        listing = await client.get("/api/workspaces")

    assert Path(default.json()["cwd"]).is_dir()
    assert accepted.json()["cwd"] == str(selected.resolve())
    assert rejected.status_code == 403
    assert str(selected.resolve()) in listing.json()["workspaces"]


@pytest.mark.asyncio
async def test_skills_list_and_toggle_only_registered_skill_files(tmp_path: Path) -> None:
    parent = tmp_path / "workspaces"
    workspace = parent / "project"
    skill_dir = workspace / ".agents" / "skills" / "demo"
    skill_dir.mkdir(parents=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(
        "---\nname: demo\ndescription: Demo skill\n---\nInstructions\n",
        encoding="utf-8",
    )
    unrelated = workspace / "notes.md"
    unrelated.write_text("notes", encoding="utf-8")
    app = create_app(
        ServerSettings(
            agent_dir=tmp_path / "agent",
            sessions_dir=tmp_path / "sessions",
            own_config_dir=tmp_path / "agent-python",
            workspace_parent=parent,
        )
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        await client.post("/api/workspaces/select", json={"cwd": str(workspace)})
        initial = await client.get("/api/skills", params={"cwd": str(workspace)})
        toggled = await client.patch(
            "/api/skills",
            json={"filePath": str(skill_file), "disableModelInvocation": True},
        )
        updated = await client.get("/api/skills", params={"cwd": str(workspace)})
        rejected = await client.patch(
            "/api/skills",
            json={"filePath": str(unrelated), "disableModelInvocation": True},
        )

    assert initial.json()["skills"][0]["disableModelInvocation"] is False
    assert toggled.json() == {"success": True}
    assert updated.json()["skills"][0]["disableModelInvocation"] is True
    assert "disable-model-invocation: true" in skill_file.read_text(encoding="utf-8")
    assert rejected.status_code == 403

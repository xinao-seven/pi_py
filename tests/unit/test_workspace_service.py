from pathlib import Path

import pytest

from server.services.workspace_service import WorkspaceService


def test_select_allows_descendants_of_registered_roots(tmp_path: Path) -> None:
    configured_parent = tmp_path / "home"
    configured_parent.mkdir()
    registered_root = tmp_path / "external" / "code"
    project = registered_root / "project"
    project.mkdir(parents=True)
    unrelated = tmp_path / "unrelated"
    unrelated.mkdir()
    service = WorkspaceService(configured_parent, lambda: [registered_root])

    assert service.select(project) == project.resolve()
    assert project.resolve() in service.roots()
    with pytest.raises(PermissionError, match="configured parent or a registered workspace"):
        service.select(unrelated)


def test_selected_workspaces_persist_across_instances(tmp_path: Path) -> None:
    parent = tmp_path / "home"
    parent.mkdir()
    project = parent / "project"
    project.mkdir()
    persist_path = tmp_path / "own" / "workspaces.json"
    service = WorkspaceService(
        parent,
        lambda: [],
        persist_path=persist_path,
    )
    service.select(project)

    # 新实例从持久化文件恢复手动登记的工作区
    reloaded = WorkspaceService(
        parent,
        lambda: [],
        persist_path=persist_path,
    )

    assert project.resolve() in reloaded.roots()
    assert persist_path.is_file()


def test_corrupt_persistence_file_falls_back_to_empty(tmp_path: Path) -> None:
    parent = tmp_path / "home"
    parent.mkdir()
    persist_path = tmp_path / "own" / "workspaces.json"
    persist_path.parent.mkdir()
    persist_path.write_text("not json {", encoding="utf-8")

    service = WorkspaceService(parent, lambda: [], persist_path=persist_path)

    assert service.roots() == ()
    # 恢复后仍可正常登记并覆盖损坏文件
    project = parent / "project"
    project.mkdir()
    assert service.select(project) == project.resolve()
    assert "project" in persist_path.read_text(encoding="utf-8")

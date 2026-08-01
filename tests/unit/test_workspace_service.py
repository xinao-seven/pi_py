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

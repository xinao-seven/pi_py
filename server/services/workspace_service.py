"""Controlled local workspace discovery without launching a GUI picker."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime, timezone
from pathlib import Path


class WorkspaceService:
    def __init__(
        self,
        workspace_parent: str | Path,
        known_roots_provider: Callable[[], Iterable[str | Path]],
    ) -> None:
        self.workspace_parent = Path(workspace_parent).expanduser().resolve()
        self._known_roots_provider = known_roots_provider
        self._selected: dict[str, Path] = {}

    def roots(self) -> tuple[Path, ...]:
        roots = [Path(item).expanduser().resolve() for item in self._known_roots_provider()]
        roots.extend(self._selected.values())
        unique = {_key(root): root for root in roots if root.is_dir()}
        return tuple(unique.values())

    def is_allowed(self, path: str | Path) -> bool:
        resolved = Path(path).expanduser().resolve()
        return _key(resolved) in {_key(root) for root in self.roots()}

    def select(self, path: str | Path) -> Path:
        resolved = Path(path).expanduser().resolve()
        if not resolved.is_dir():
            raise ValueError(f"Workspace does not exist: {path}")
        if not _is_within(resolved, self.workspace_parent) and not self.is_allowed(resolved):
            raise PermissionError(
                f"Workspace must be inside configured parent: {self.workspace_parent}"
            )
        self._selected[_key(resolved)] = resolved
        return resolved

    def create_default(self) -> Path:
        date = datetime.now(timezone.utc).strftime("%Y%m%d")
        self.workspace_parent.mkdir(parents=True, exist_ok=True)
        workspace = self.workspace_parent / f"pi-cwd-{date}"
        workspace.mkdir(parents=True, exist_ok=True)
        self._selected[_key(workspace)] = workspace
        return workspace


def _key(path: Path) -> str:
    return str(path).casefold()


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False

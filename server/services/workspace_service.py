"""Controlled local workspace discovery without launching a GUI picker.

中文说明：受控工作区服务：替代原生文件夹选择器——只允许登记
位于配置父目录之下或已在已知工作区内的目录，并提供默认工作区创建。
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime, timezone
from pathlib import Path


class WorkspaceService:
    """工作区登记与默认创建；roots 由已知根 + 用户选择组成。"""
    def __init__(
        self,
        workspace_parent: str | Path,
        known_roots_provider: Callable[[], Iterable[str | Path]],
    ) -> None:
        self.workspace_parent = Path(workspace_parent).expanduser().resolve()
        self._known_roots_provider = known_roots_provider
        self._selected: dict[str, Path] = {}

    def roots(self) -> tuple[Path, ...]:
        """合并已知根与手动选择，去重后返回。"""
        roots = [Path(item).expanduser().resolve() for item in self._known_roots_provider()]
        roots.extend(self._selected.values())
        unique = {_key(root): root for root in roots if root.is_dir()}
        return tuple(unique.values())

    def is_allowed(self, path: str | Path) -> bool:
        """判断目录是否在允许范围内。"""
        resolved = Path(path).expanduser().resolve()
        return _key(resolved) in {_key(root) for root in self.roots()}

    def select(self, path: str | Path) -> Path:
        """登记一个已有目录；必须在父目录或已知工作区内，否则拒绝。"""
        resolved = Path(path).expanduser().resolve()
        if not resolved.is_dir():
            raise ValueError(f"Workspace does not exist: {path}")
        known_roots = self.roots()
        if not _is_within(resolved, self.workspace_parent) and not any(
            _is_within(resolved, root) for root in known_roots
        ):
            raise PermissionError(
                "Workspace must be inside the configured parent or a registered workspace: "
                f"{self.workspace_parent}"
            )
        self._selected[_key(resolved)] = resolved
        return resolved

    def create_default(self) -> Path:
        """在父目录下创建默认工作区（pi-cwd-YYYYMMDD）。"""
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

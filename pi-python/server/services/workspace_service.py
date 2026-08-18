"""Controlled local workspace discovery without launching a GUI picker.

中文说明：受控工作区服务：替代原生文件夹选择器——只允许登记
位于配置父目录之下或已在已知工作区内的目录，并提供默认工作区创建。
用户手动登记的工作区可持久化到 pi.py 自身配置目录，重启后仍可复用。
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4


class WorkspaceService:
    """工作区登记与默认创建；roots 由已知根 + 用户选择组成。"""
    def __init__(
        self,
        workspace_parent: str | Path,
        known_roots_provider: Callable[[], Iterable[str | Path]],
        *,
        persist_path: str | Path | None = None,
    ) -> None:
        self.workspace_parent = Path(workspace_parent).expanduser().resolve()
        self._known_roots_provider = known_roots_provider
        # 手动登记的工作区：持久化路径可空（内存模式，测试用）
        self._persist_path = (
            Path(persist_path).expanduser().resolve() if persist_path else None
        )
        self._selected: dict[str, Path] = self._load()

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
        """登记用户显式选择的任一已有本地目录为工作区。"""
        resolved = Path(path).expanduser().resolve()
        if not resolved.is_dir():
            raise ValueError(f"Workspace does not exist: {path}")
        self._selected[_key(resolved)] = resolved
        self._save()
        return resolved

    def create_default(self) -> Path:
        """在父目录下创建默认工作区（pi-cwd-YYYYMMDD）。"""
        date = datetime.now(timezone.utc).strftime("%Y%m%d")
        self.workspace_parent.mkdir(parents=True, exist_ok=True)
        workspace = self.workspace_parent / f"pi-cwd-{date}"
        workspace.mkdir(parents=True, exist_ok=True)
        self._selected[_key(workspace)] = workspace
        self._save()
        return workspace

    def _load(self) -> dict[str, Path]:
        """从持久化文件恢复手动登记的工作区；缺失/损坏时返回空。"""
        if self._persist_path is None or not self._persist_path.is_file():
            return {}
        try:
            value = json.loads(self._persist_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        workspaces = value.get("workspaces") if isinstance(value, dict) else None
        if not isinstance(workspaces, list):
            return {}
        return {
            _key(Path(item)): Path(item)
            for item in workspaces
            if isinstance(item, str) and Path(item).is_dir()
        }

    def _save(self) -> None:
        """原子写入手动登记的工作区列表（仅登记目录，不写任何其他配置）。"""
        if self._persist_path is None:
            return
        try:
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._persist_path.with_name(
                f".workspaces.{uuid4().hex}.tmp"
            )
            temporary.write_text(
                json.dumps(
                    {"workspaces": sorted(str(path) for path in self._selected.values())},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
                newline="\n",
            )
            temporary.replace(self._persist_path)
        except OSError:
            # 持久化失败不应阻断工作区切换（退化为内存模式）
            pass


def _key(path: Path) -> str:
    return str(path).casefold()

"""Workspace path resolution and mutation serialization.

中文说明：工作区路径解析与写操作串行化：所有工具路径必须先解析，
并强制落在工作区根目录内；对同一文件的写操作互斥。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from pi_agent.types import ToolError


class WorkspacePaths:
    """工作区路径边界：resolve 校验路径在根目录内；mutation_lock 串行化写操作。"""
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        # 每个路径一把写锁，避免并发工具调用同时改写同一文件
        self._mutation_locks: dict[Path, asyncio.Lock] = {}

    def resolve(self, raw_path: object, *, must_exist: bool = False) -> Path:
        """解析相对/绝对路径：展开 ~，解析真实路径后再做边界检查；
        must_exist=True 时还要求目标存在。"""
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ToolError("path must be a non-empty string")
        expanded = Path(raw_path.strip()).expanduser()
        candidate = expanded if expanded.is_absolute() else self.root / expanded
        resolved = candidate.resolve(strict=False)
        try:
            resolved.relative_to(self.root)
        except ValueError as error:
            # 真实路径落在工作区外：拒绝（防止 ../ 或符号链接逃逸）
            raise ToolError(f"Path is outside the workspace: {raw_path}") from error
        if must_exist and not resolved.exists():
            raise ToolError(f"Path not found: {raw_path}")
        return resolved

    def mutation_lock(self, path: Path) -> asyncio.Lock:
        """获取某路径的写锁（惰性创建）。"""
        lock = self._mutation_locks.get(path)
        if lock is None:
            lock = asyncio.Lock()
            self._mutation_locks[path] = lock
        return lock

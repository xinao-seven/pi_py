"""Workspace path resolution and mutation serialization."""

from __future__ import annotations

import asyncio
from pathlib import Path

from pi_agent.types import ToolError


class WorkspacePaths:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self._mutation_locks: dict[Path, asyncio.Lock] = {}

    def resolve(self, raw_path: object, *, must_exist: bool = False) -> Path:
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ToolError("path must be a non-empty string")
        expanded = Path(raw_path.strip()).expanduser()
        candidate = expanded if expanded.is_absolute() else self.root / expanded
        resolved = candidate.resolve(strict=False)
        try:
            resolved.relative_to(self.root)
        except ValueError as error:
            raise ToolError(f"Path is outside the workspace: {raw_path}") from error
        if must_exist and not resolved.exists():
            raise ToolError(f"Path not found: {raw_path}")
        return resolved

    def mutation_lock(self, path: Path) -> asyncio.Lock:
        lock = self._mutation_locks.get(path)
        if lock is None:
            lock = asyncio.Lock()
            self._mutation_locks[path] = lock
        return lock

"""Discover and serialize persistent pi Session files."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

from pi_coding_agent.core.session_manager import (
    SessionInfo,
    SessionManager,
    build_session_info,
)


class SessionStore:
    def __init__(self, sessions_dir: str | Path) -> None:
        self.sessions_dir = Path(sessions_dir).expanduser().resolve()

    def list(self) -> list[SessionInfo]:
        if not self.sessions_dir.is_dir():
            return []
        sessions = [
            info
            for path in self.sessions_dir.rglob("*.jsonl")
            if (info := build_session_info(path)) is not None
        ]
        sessions.sort(key=lambda item: item.modified, reverse=True)
        return sessions

    def list_orphans(self) -> list[dict[str, Any]]:
        if not self.sessions_dir.is_dir():
            return []
        known = {_path_key(info.path.resolve()) for info in self.list()}
        return [
            orphan_session_to_dict(path)
            for path in self.sessions_dir.rglob("*.jsonl")
            if _path_key(path.resolve()) not in known
        ]

    def find(self, session_id: str) -> SessionInfo | None:
        return next((info for info in self.list() if info.id == session_id), None)

    def open(self, session_id: str) -> SessionManager | None:
        info = self.find(session_id)
        return SessionManager.open(info.path) if info is not None else None

    def session_directory(self, cwd: str | Path) -> Path:
        """Use one deterministic directory per workspace without exposing its path."""
        resolved = Path(cwd).resolve()
        label = re.sub(r"[^A-Za-z0-9._-]+", "-", resolved.name).strip("-") or "workspace"
        digest = hashlib.sha256(str(resolved).casefold().encode("utf-8")).hexdigest()[:12]
        return self.sessions_dir / f"{label[:40]}-{digest}"

    def delete_with_reparent(self, session_id: str) -> int | None:
        target_info = self.find(session_id)
        if target_info is None:
            return None
        target_path = target_info.path.resolve()
        target_manager = SessionManager.open(target_path)
        parent_path = target_manager.get_header().get("parentSession")
        parent = parent_path if isinstance(parent_path, str) and parent_path else None
        children = [
            info
            for info in self.list()
            if info.path.resolve() != target_path
            and info.parent_session_path
            and _path_key(Path(info.parent_session_path).resolve()) == _path_key(target_path)
        ]
        for child in children:
            _rewrite_parent_session(child.path, parent)
        target_path.unlink()
        return len(children)


def session_info_to_dict(
    info: SessionInfo,
    *,
    parent_session_id: str | None = None,
) -> dict[str, Any]:
    values = asdict(info)
    values["path"] = str(info.path)
    values["created"] = info.created.isoformat()
    values["modified"] = info.modified.isoformat()
    values["parentSessionId"] = parent_session_id
    values["parentSessionPath"] = values.pop("parent_session_path")
    values["messageCount"] = values.pop("message_count")
    values["firstMessage"] = values.pop("first_message")
    values.pop("all_messages_text")
    return values


def session_info_list_to_dict(infos: Iterable[SessionInfo]) -> list[dict[str, Any]]:
    items = list(infos)
    ids_by_path = {_path_key(info.path.resolve()): info.id for info in items}
    return [
        session_info_to_dict(
            info,
            parent_session_id=(
                ids_by_path.get(_path_key(Path(info.parent_session_path).resolve()))
                if info.parent_session_path
                else None
            ),
        )
        for info in items
    ]


def orphan_session_to_dict(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    try:
        stat = resolved.stat()
        modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
    except OSError:
        modified = datetime.now(timezone.utc).isoformat()
    digest = hashlib.sha256(str(resolved).casefold().encode("utf-8")).hexdigest()[:16]
    return {
        "id": f"orphan-{digest}",
        "path": str(resolved),
        "cwd": "",
        "name": resolved.stem,
        "created": modified,
        "modified": modified,
        "messageCount": 0,
        "firstMessage": "无法读取 Session 文件",
        "parentSessionId": None,
        "parentSessionPath": None,
        "orphaned": True,
        "orphanReason": "Session 文件缺少有效的 v3 header 或内容已损坏",
    }


def session_detail(
    manager: SessionManager,
    info: SessionInfo | None = None,
    *,
    parent_session_id: str | None = None,
) -> dict[str, Any]:
    header = manager.get_header()
    context = manager.build_web_session_context()
    resolved_info = info or (
        build_session_info(manager.session_file) if manager.session_file is not None else None
    )
    return {
        "sessionId": manager.session_id,
        "filePath": str(manager.session_file) if manager.session_file is not None else None,
        "info": (
            session_info_to_dict(resolved_info, parent_session_id=parent_session_id)
            if resolved_info is not None
            else {
                "path": None,
                "id": manager.session_id,
                "cwd": str(manager.cwd),
                "name": manager.get_session_name(),
                "created": header.get("timestamp"),
                "modified": header.get("timestamp"),
                "messageCount": len(context["messages"]),
                "firstMessage": "",
                "parentSessionId": None,
                "parentSessionPath": header.get("parentSession"),
            }
        ),
        "tree": manager.get_tree(),
        "leafId": manager.leaf_id,
        "context": context,
    }


def _path_key(path: Path) -> str:
    return str(path).casefold()


def _rewrite_parent_session(path: Path, parent_path: str | None) -> None:
    content = path.read_text(encoding="utf-8")
    lines = content.splitlines()
    if not lines:
        raise ValueError(f"Session file is empty: {path}")
    header = json.loads(lines[0])
    if not isinstance(header, dict) or header.get("type") != "session":
        raise ValueError(f"Session file has no valid header: {path}")
    if parent_path:
        header["parentSession"] = parent_path
    else:
        header.pop("parentSession", None)
    lines[0] = json.dumps(header, ensure_ascii=False, separators=(",", ":"))
    rewritten = "\n".join(lines) + ("\n" if content.endswith(("\n", "\r")) else "")
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_text(rewritten, encoding="utf-8", newline="\n")
    temporary.replace(path)

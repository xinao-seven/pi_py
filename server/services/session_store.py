"""Discover and serialize persistent pi Session files."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any

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

    def find(self, session_id: str) -> SessionInfo | None:
        return next((info for info in self.list() if info.id == session_id), None)

    def open(self, session_id: str) -> SessionManager | None:
        info = self.find(session_id)
        return SessionManager.open(info.path) if info is not None else None

    def session_directory(self, cwd: str | Path) -> Path:
        """Use one deterministic directory per workspace without exposing its path."""
        resolved = Path(cwd).resolve()
        safe_name = resolved.drive.replace(":", "") + resolved.as_posix().replace("/", "-")
        safe_name = safe_name.strip("-") or "root"
        return self.sessions_dir / safe_name


def session_info_to_dict(info: SessionInfo) -> dict[str, Any]:
    values = asdict(info)
    values["path"] = str(info.path)
    values["created"] = info.created.isoformat()
    values["modified"] = info.modified.isoformat()
    values["parentSessionId"] = None
    values["parentSessionPath"] = values.pop("parent_session_path")
    values["messageCount"] = values.pop("message_count")
    values["firstMessage"] = values.pop("first_message")
    values.pop("all_messages_text")
    return values


def session_detail(manager: SessionManager, info: SessionInfo | None = None) -> dict[str, Any]:
    header = manager.get_header()
    context = manager.build_web_session_context()
    resolved_info = info or (
        build_session_info(manager.session_file) if manager.session_file is not None else None
    )
    return {
        "sessionId": manager.session_id,
        "filePath": str(manager.session_file) if manager.session_file is not None else None,
        "info": (
            session_info_to_dict(resolved_info)
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

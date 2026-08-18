"""Coding-agent Session v3 JSONL parsing, traversal, and persistence.

The data layer deliberately uses plain dictionaries. Session files are a public
compatibility boundary and may contain extension-defined fields that must survive
a read/write cycle even when this implementation does not understand them.

中文说明：Session v3 JSONL 数据层。Session 文件是与 pi 兼容的公开边界，
因此刻意使用普通字典读写并保留未知扩展字段。本模块负责解析、迁移、
树/分支遍历、compaction-aware 上下文构建与 append-only 持久化。
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any, Final, Iterable, Mapping, TypeAlias
from uuid import uuid4

CURRENT_SESSION_VERSION: Final = 3
# Session id 必须满足的文件名安全模式（字母数字开头结尾，可含 - _ .）
SESSION_ID_PATTERN: Final = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")

JsonObject: TypeAlias = dict[str, Any]
SessionEntry: TypeAlias = JsonObject
FileEntry: TypeAlias = JsonObject

_LATEST_LEAF = object()


@dataclass(frozen=True, slots=True)
class SessionInfo:
    """Metadata used by session selectors and the Web sidebar.

    中文说明：会话选择器与 Web 侧栏使用的会话元数据（路径、id、cwd、
    创建/修改时间、消息数、首条消息与全文摘要文本）。
    """

    path: Path
    id: str
    cwd: str
    name: str | None
    parent_session_path: str | None
    created: datetime
    modified: datetime
    message_count: int
    first_message: str
    all_messages_text: str


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _timestamp_ms(value: object) -> int:
    if not isinstance(value, str):
        return 0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0
    return int(parsed.timestamp() * 1000)


def _parse_datetime(value: object, fallback: datetime) -> datetime:
    if not isinstance(value, str):
        return fallback
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return fallback
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _new_entry_id(existing_ids: Iterable[str]) -> str:
    existing = set(existing_ids)
    for _ in range(100):
        candidate = uuid4().hex[:8]
        if candidate not in existing:
            return candidate
    return str(uuid4())


def assert_valid_session_id(session_id: str) -> None:
    """Validate IDs before using them in a session filename."""

    if not SESSION_ID_PATTERN.fullmatch(session_id):
        raise ValueError(
            "Session id must contain only alphanumeric characters, '-', '_', and '.', "
            "and start and end with an alphanumeric character"
        )


def parse_session_entries(content: str) -> list[FileEntry]:
    """Parse JSONL, skipping blank, malformed, and non-object lines.

    中文说明：解析 JSONL：跳过空行、坏行与非对象行，逐行还原为字典。
    """

    entries: list[FileEntry] = []
    for line in content.splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            entries.append(value)
    return entries


def migrate_session_entries(entries: list[FileEntry]) -> bool:
    """Migrate entries in place to Session v3 and report whether they changed.

    中文说明：原地迁移到 Session v3。v1->v2 为每条记录补 id/parentId 链；
    v2->v3 把 hookMessage 角色改名为 custom。返回是否发生了修改。
    """

    header = next((entry for entry in entries if entry.get("type") == "session"), None)
    version = header.get("version", 1) if header else 1
    if not isinstance(version, int):
        version = 1
    if version >= CURRENT_SESSION_VERSION:
        return False

    if version < 2:
        # v1 -> v2：为每条非 session 记录生成 id，并按顺序串成 parentId 链
        existing_ids: set[str] = set()
        previous_id: str | None = None
        for entry in entries:
            if entry.get("type") == "session":
                entry["version"] = 2
                continue
            entry_id = _new_entry_id(existing_ids)
            existing_ids.add(entry_id)
            entry["id"] = entry_id
            entry["parentId"] = previous_id
            previous_id = entry_id
            if entry.get("type") == "compaction" and isinstance(entry.get("firstKeptEntryIndex"), int):
                target_index = entry["firstKeptEntryIndex"]
                if 0 <= target_index < len(entries):
                    target = entries[target_index]
                    if target.get("type") != "session" and isinstance(target.get("id"), str):
                        entry["firstKeptEntryId"] = target["id"]
                entry.pop("firstKeptEntryIndex", None)

    if version < 3:
        # v2 -> v3：hookMessage 角色统一改名为 custom
        for entry in entries:
            if entry.get("type") == "session":
                entry["version"] = 3
            elif entry.get("type") == "message":
                message = entry.get("message")
                if isinstance(message, dict) and message.get("role") == "hookMessage":
                    message["role"] = "custom"
    return True


def _entry_index(entries: Iterable[SessionEntry]) -> dict[str, SessionEntry]:
    return {
        entry["id"]: entry
        for entry in entries
        if isinstance(entry.get("id"), str)
    }


def build_session_path(
    entries: list[SessionEntry],
    leaf_id: str | None | object = _LATEST_LEAF,
    *,
    by_id: Mapping[str, SessionEntry] | None = None,
) -> list[SessionEntry]:
    """Return the root-to-leaf path.

    Omitting ``leaf_id`` selects the last entry, while explicitly passing None
    represents the empty root before the first entry. This avoids JavaScript's
    undefined/null ambiguity while preserving the behavior needed by navigation.

    中文说明：返回从根到指定叶节点的路径。省略 leaf_id 取最后一条记录；
    显式传 None 表示首条记录之前的空根。
    """

    if leaf_id is None:
        return []
    index = dict(by_id) if by_id is not None else _entry_index(entries)
    leaf: SessionEntry | None = None
    if isinstance(leaf_id, str):
        leaf = index.get(leaf_id)
    if leaf is None and entries:
        leaf = entries[-1]
    if leaf is None:
        return []

    reverse_path: list[SessionEntry] = []
    seen: set[str] = set()
    current: SessionEntry | None = leaf
    while current is not None:
        current_id = current.get("id")
        if isinstance(current_id, str):
            if current_id in seen:
                break
            seen.add(current_id)
        reverse_path.append(current)
        parent_id = current.get("parentId")
        current = index.get(parent_id) if isinstance(parent_id, str) else None
    reverse_path.reverse()
    return reverse_path


def _context_settings(path: Iterable[SessionEntry]) -> tuple[str, dict[str, str] | None]:
    thinking_level = "off"
    model: dict[str, str] | None = None
    for entry in path:
        entry_type = entry.get("type")
        if entry_type == "thinking_level_change" and isinstance(entry.get("thinkingLevel"), str):
            thinking_level = entry["thinkingLevel"]
        elif entry_type == "model_change":
            if isinstance(entry.get("provider"), str) and isinstance(entry.get("modelId"), str):
                model = {"provider": entry["provider"], "modelId": entry["modelId"]}
        elif entry_type == "message":
            message = entry.get("message")
            if (
                isinstance(message, dict)
                and message.get("role") == "assistant"
                and isinstance(message.get("provider"), str)
                and isinstance(message.get("model"), str)
            ):
                model = {"provider": message["provider"], "modelId": message["model"]}
    return thinking_level, model


def build_context_entries(
    entries: list[SessionEntry],
    leaf_id: str | None | object = _LATEST_LEAF,
    *,
    by_id: Mapping[str, SessionEntry] | None = None,
) -> list[SessionEntry]:
    """Build the active branch with the latest compaction applied.

    中文说明：构建应用了最近一次 compaction 的活动分支：
    用压缩摘要替换被裁剪的历史，只保留 firstKeptEntryId 之后的旧消息。
    """

    path = build_session_path(entries, leaf_id, by_id=by_id)
    # 从路径尾部向前找最近一次 compaction
    compaction = next(
        (entry for entry in reversed(path) if entry.get("type") == "compaction"),
        None,
    )
    if compaction is None:
        return path
    compaction_index = path.index(compaction)
    result = [compaction]
    first_kept = compaction.get("firstKeptEntryId")
    keep = False
    for entry in path[:compaction_index]:
        if entry.get("id") == first_kept:
            keep = True
        if keep:
            result.append(entry)
    result.extend(path[compaction_index + 1 :])
    return result


def session_entry_to_context_messages(entry: SessionEntry) -> list[JsonObject]:
    """Project one persisted entry into runtime messages.

    中文说明：把一条持久化记录投影成运行时消息：message/custom_message/
    branch_summary/compaction 分别映射为对应的运行时消息角色。
    """

    entry_type = entry.get("type")
    timestamp = _timestamp_ms(entry.get("timestamp"))
    if entry_type == "message" and isinstance(entry.get("message"), dict):
        message = deepcopy(entry["message"])
        if message.get("role") in {"user", "assistant", "toolResult"} and message.get("content") is None:
            message["content"] = []
        return [message]
    if entry_type == "custom_message":
        return [{
            "role": "custom",
            "customType": entry.get("customType", ""),
            "content": deepcopy(entry.get("content", [])),
            "display": bool(entry.get("display", False)),
            "details": deepcopy(entry.get("details")),
            "timestamp": timestamp,
        }]
    if entry_type == "branch_summary" and entry.get("summary"):
        return [{
            "role": "branchSummary",
            "summary": entry["summary"],
            "fromId": entry.get("fromId", "root"),
            "timestamp": timestamp,
        }]
    if entry_type == "compaction":
        return [{
            "role": "compactionSummary",
            "summary": entry.get("summary", ""),
            "tokensBefore": entry.get("tokensBefore", 0),
            "timestamp": timestamp,
        }]
    return []


def build_session_context(
    entries: list[SessionEntry],
    leaf_id: str | None | object = _LATEST_LEAF,
    *,
    by_id: Mapping[str, SessionEntry] | None = None,
) -> JsonObject:
    """Build messages and settings for one active session branch.

    中文说明：构建单个活动分支的运行时上下文：消息列表 + 沿途最近的
    思考档位与模型设置（模型切换/思考切换会覆盖此前设置）。
    """

    path = build_session_path(entries, leaf_id, by_id=by_id)
    thinking_level, model = _context_settings(path)
    messages = [
        message
        for entry in build_context_entries(entries, leaf_id, by_id=by_id)
        for message in session_entry_to_context_messages(entry)
    ]
    return {"messages": messages, "thinkingLevel": thinking_level, "model": model}


def build_session_context_with_entry_ids(
    entries: list[SessionEntry],
    leaf_id: str | None | object = _LATEST_LEAF,
    *,
    by_id: Mapping[str, SessionEntry] | None = None,
) -> JsonObject:
    """Build Web-facing context with an entry ID parallel to every message.

    中文说明：Web 端使用的上下文：每条消息附带对应的 entryId，
    用于 SSE 断线重连时按 id 去重。
    """

    context = build_session_context(entries, leaf_id, by_id=by_id)
    entry_ids: list[str] = []
    for entry in build_context_entries(entries, leaf_id, by_id=by_id):
        entry_id = entry.get("id")
        if not isinstance(entry_id, str):
            continue
        entry_ids.extend(entry_id for _ in session_entry_to_context_messages(entry))
    return {**context, "entryIds": entry_ids}


def _extract_text_content(message: Mapping[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return " ".join(
        str(block.get("text"))
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    )


def build_session_info(path: str | Path) -> SessionInfo | None:
    """Read sidebar metadata without constructing a live SessionManager.

    中文说明：只读侧栏元数据，不创建活动 SessionManager；无效文件返回 None。
    """

    file_path = Path(path).resolve()
    try:
        stat = file_path.stat()
        entries = parse_session_entries(file_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return None
    if not entries or entries[0].get("type") != "session":
        return None
    header = entries[0]
    if not isinstance(header.get("id"), str):
        return None
    fallback = datetime.fromtimestamp(stat.st_mtime, timezone.utc)
    created = _parse_datetime(header.get("timestamp"), fallback)
    modified = created
    message_count = 0
    first_message = ""
    all_messages: list[str] = []
    name: str | None = None
    for entry in entries[1:]:
        if entry.get("type") == "session_info":
            raw_name = entry.get("name")
            name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else None
        if entry.get("type") != "message" or not isinstance(entry.get("message"), dict):
            continue
        message_count += 1
        message = entry["message"]
        role = message.get("role")
        if role not in {"user", "assistant"}:
            continue
        message_timestamp = message.get("timestamp")
        if isinstance(message_timestamp, (int, float)):
            activity = datetime.fromtimestamp(message_timestamp / 1000, timezone.utc)
        else:
            activity = _parse_datetime(entry.get("timestamp"), modified)
        if activity > modified:
            modified = activity
        text = _extract_text_content(message)
        if not text:
            continue
        all_messages.append(text)
        if not first_message and role == "user":
            first_message = text
    return SessionInfo(
        path=file_path,
        id=header["id"],
        cwd=header.get("cwd") if isinstance(header.get("cwd"), str) else "",
        name=name,
        parent_session_path=(
            header.get("parentSession") if isinstance(header.get("parentSession"), str) else None
        ),
        created=created,
        modified=modified,
        message_count=message_count,
        first_message=first_message or "(no messages)",
        all_messages_text=" ".join(all_messages),
    )


def find_most_recent_session(session_dir: str | Path, *, cwd: str | Path | None = None) -> Path | None:
    """Return the newest valid JSONL session, optionally restricted by cwd.

    中文说明：返回目录中最新的有效 JSONL 会话文件，可限定 cwd。
    """

    directory = Path(session_dir).resolve()
    expected_cwd = Path(cwd).resolve() if cwd is not None else None
    if not directory.is_dir():
        return None
    candidates: list[tuple[int, Path]] = []
    for file_path in directory.glob("*.jsonl"):
        info = build_session_info(file_path)
        if info is None:
            continue
        if expected_cwd is not None:
            if not info.cwd or Path(info.cwd).resolve() != expected_cwd:
                continue
        try:
            modified_ns = file_path.stat().st_mtime_ns
        except OSError:
            continue
        candidates.append((modified_ns, file_path.resolve()))
    return max(candidates, default=(0, None), key=lambda item: item[0])[1]


class SessionManager:
    """Append-only manager for one pi-compatible Session v3 file.

    中文说明：单个 Session v3 文件的追加式管理器：新建/打开/持久化/分支/树遍历。
    记录只能追加，通过 parentId 形成树；活动叶节点决定当前上下文。
    """

    def __init__(
        self,
        *,
        cwd: Path,
        session_dir: Path | None,
        session_file: Path | None,
        persist: bool,
        session_id: str | None = None,
        parent_session: str | None = None,
        file_entries: list[FileEntry] | None = None,
    ) -> None:
        # 新建会话：生成 header；持久化模式下会话文件放在 session_dir 下
        self._cwd = cwd.resolve()
        self._session_dir = session_dir.resolve() if session_dir else None
        self._session_file = session_file.resolve() if session_file else None
        self._persist = persist
        self._flushed = False

        if file_entries is None:
            if session_id is not None:
                assert_valid_session_id(session_id)
            self._session_id = session_id or str(uuid4())
            timestamp = _iso_now()
            header: FileEntry = {
                "type": "session",
                "version": CURRENT_SESSION_VERSION,
                "id": self._session_id,
                "timestamp": timestamp,
                "cwd": str(self._cwd),
            }
            if parent_session is not None:
                header["parentSession"] = parent_session
            self._file_entries = [header]
            if self._persist and self._session_file is None:
                if self._session_dir is None:
                    raise ValueError("A persistent session requires a session directory")
                safe_time = timestamp.replace(":", "-").replace(".", "-")
                self._session_file = self._session_dir / f"{safe_time}_{self._session_id}.jsonl"
        else:
            # 打开已有会话：直接用文件内容，id 来自 header
            self._file_entries = file_entries
            header = next((entry for entry in file_entries if entry.get("type") == "session"), None)
            if header is None or not isinstance(header.get("id"), str):
                raise ValueError("Session file has no valid session header")
            self._session_id = header["id"]
            self._flushed = bool(self._session_file and self._session_file.exists())
        if self._persist and self._session_dir:
            self._session_dir.mkdir(parents=True, exist_ok=True)
        self._rebuild_index()

    @classmethod
    def in_memory(cls, cwd: str | Path = ".", *, session_id: str | None = None) -> SessionManager:
        """创建不落盘的内存会话（测试或临时使用）。"""
        return cls(
            cwd=Path(cwd),
            session_dir=None,
            session_file=None,
            persist=False,
            session_id=session_id,
        )

    @classmethod
    def create(
        cls,
        cwd: str | Path,
        session_dir: str | Path,
        *,
        session_id: str | None = None,
        parent_session: str | None = None,
    ) -> SessionManager:
        """在指定目录新建一个持久化会话。"""
        return cls(
            cwd=Path(cwd),
            session_dir=Path(session_dir),
            session_file=None,
            persist=True,
            session_id=session_id,
            parent_session=parent_session,
        )

    @classmethod
    def open(cls, path: str | Path, *, cwd_override: str | Path | None = None) -> SessionManager:
        """打开已有会话文件；不存在时新建；旧版本自动迁移并重写文件。"""
        session_file = Path(path).resolve()
        if not session_file.exists():
            return cls(
                cwd=Path(cwd_override or Path.cwd()),
                session_dir=session_file.parent,
                session_file=session_file,
                persist=True,
            )
        content = session_file.read_text(encoding="utf-8")
        entries = parse_session_entries(content)
        if not entries:
            if content:
                raise ValueError(f"Session file is not a valid pi session: {session_file}")
            manager = cls(
                cwd=Path(cwd_override or Path.cwd()),
                session_dir=session_file.parent,
                session_file=session_file,
                persist=True,
            )
            manager._rewrite_file()
            manager._flushed = True
            return manager
        header = next((entry for entry in entries if entry.get("type") == "session"), None)
        if header is None:
            raise ValueError(f"Session file has no valid session header: {session_file}")
        migrated = migrate_session_entries(entries)
        cwd = Path(cwd_override) if cwd_override else Path(str(header.get("cwd") or Path.cwd()))
        manager = cls(
            cwd=cwd,
            session_dir=session_file.parent,
            session_file=session_file,
            persist=True,
            file_entries=entries,
        )
        if migrated:
            manager._rewrite_file()
        return manager

    def _rebuild_index(self) -> None:
        # 重建 id -> entry 索引、当前叶节点与标签表（标签以最新一条为准）
        entries = self.get_entries()
        self._by_id = _entry_index(entries)
        self._leaf_id = entries[-1].get("id") if entries and isinstance(entries[-1].get("id"), str) else None
        self._labels: dict[str, tuple[str, str]] = {}
        for entry in entries:
            if entry.get("type") != "label" or not isinstance(entry.get("targetId"), str):
                continue
            target_id = entry["targetId"]
            label = entry.get("label")
            if isinstance(label, str) and label:
                self._labels[target_id] = (label, str(entry.get("timestamp", "")))
            else:
                self._labels.pop(target_id, None)

    def _rewrite_file(self) -> None:
        """把全部记录整体写回文件（用于首次落盘与迁移后的重写）。"""
        if not self._persist or self._session_file is None:
            return
        self._session_file.parent.mkdir(parents=True, exist_ok=True)
        text = "".join(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n" for entry in self._file_entries)
        self._session_file.write_text(text, encoding="utf-8", newline="\n")

    def _persist_entry(self, entry: SessionEntry) -> None:
        """追加单条记录：尚无 assistant 消息前不落盘（避免只含 header 的空文件）。"""
        if not self._persist or self._session_file is None:
            return
        has_assistant = any(
            item.get("type") == "message"
            and isinstance(item.get("message"), dict)
            and item["message"].get("role") == "assistant"
            for item in self._file_entries
        )
        if not has_assistant:
            return
        if not self._flushed:
            if self._session_file.exists():
                raise FileExistsError(self._session_file)
            self._rewrite_file()
            self._flushed = True
        else:
            with self._session_file.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")

    def _append(self, entry_type: str, **fields: Any) -> str:
        """通用追加：生成新 id、链接到当前叶节点、更新索引并持久化。"""
        entry_id = _new_entry_id(self._by_id)
        entry: SessionEntry = {
            "type": entry_type,
            "id": entry_id,
            "parentId": self._leaf_id,
            "timestamp": _iso_now(),
            **fields,
        }
        self._file_entries.append(entry)
        self._by_id[entry_id] = entry
        self._leaf_id = entry_id
        self._persist_entry(entry)
        return entry_id

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def session_file(self) -> Path | None:
        return self._session_file

    @property
    def cwd(self) -> Path:
        return self._cwd

    @property
    def leaf_id(self) -> str | None:
        return self._leaf_id

    def get_header(self) -> FileEntry:
        return deepcopy(self._file_entries[0])

    def get_entries(self) -> list[SessionEntry]:
        return deepcopy([entry for entry in self._file_entries if entry.get("type") != "session"])

    def get_entry(self, entry_id: str) -> SessionEntry | None:
        entry = self._by_id.get(entry_id)
        return deepcopy(entry) if entry else None

    def append_message(self, message: Mapping[str, Any]) -> str:
        """追加一条对话消息（compaction/branch 摘要必须用专用方法）。"""
        role = message.get("role")
        if role in {"compactionSummary", "branchSummary"}:
            raise ValueError(f"{role} must use its dedicated append method")
        return self._append("message", message=deepcopy(dict(message)))

    def append_thinking_level_change(self, thinking_level: str) -> str:
        """记录一次思考档位切换。"""
        return self._append("thinking_level_change", thinkingLevel=thinking_level)

    def append_model_change(self, provider: str, model_id: str) -> str:
        """记录一次模型切换。"""
        return self._append("model_change", provider=provider, modelId=model_id)

    def append_compaction(
        self,
        summary: str,
        first_kept_entry_id: str,
        tokens_before: int,
        *,
        details: object | None = None,
        from_hook: bool | None = None,
        usage: Mapping[str, Any] | None = None,
    ) -> str:
        """追加一条压缩摘要记录。"""
        fields: JsonObject = {
            "summary": summary,
            "firstKeptEntryId": first_kept_entry_id,
            "tokensBefore": tokens_before,
        }
        if details is not None:
            fields["details"] = deepcopy(details)
        if from_hook is not None:
            fields["fromHook"] = from_hook
        if usage is not None:
            fields["usage"] = deepcopy(dict(usage))
        return self._append("compaction", **fields)

    def append_custom_entry(self, custom_type: str, data: object | None = None) -> str:
        """追加一条自定义结构化记录。"""
        fields: JsonObject = {"customType": custom_type}
        if data is not None:
            fields["data"] = deepcopy(data)
        return self._append("custom", **fields)

    def append_custom_message(
        self,
        custom_type: str,
        content: str | list[JsonObject],
        *,
        display: bool,
        details: object | None = None,
    ) -> str:
        """追加一条自定义消息（如会话合并摘要）。"""
        fields: JsonObject = {
            "customType": custom_type,
            "content": deepcopy(content),
            "display": display,
        }
        if details is not None:
            fields["details"] = deepcopy(details)
        return self._append("custom_message", **fields)

    def append_session_info(self, name: str) -> str:
        """追加/更新会话名称（清洗掉换行）。"""
        sanitized = re.sub(r"[\r\n]+", " ", name).strip()
        return self._append("session_info", name=sanitized)

    def append_label_change(self, target_id: str, label: str | None) -> str:
        """给某个节点打标签；label 为 None 时清除标签。"""
        if target_id not in self._by_id:
            raise KeyError(f"Entry {target_id} not found")
        entry_id = self._append("label", targetId=target_id, label=label)
        timestamp = self._by_id[entry_id]["timestamp"]
        if label:
            self._labels[target_id] = (label, timestamp)
        else:
            self._labels.pop(target_id, None)
        return entry_id

    def get_session_name(self) -> str | None:
        for entry in reversed(self.get_entries()):
            if entry.get("type") == "session_info":
                name = entry.get("name")
                return name.strip() if isinstance(name, str) and name.strip() else None
        return None

    def branch(self, entry_id: str) -> None:
        """把叶节点切换到既有记录（形成分支导航）。"""
        if entry_id not in self._by_id:
            raise KeyError(f"Entry {entry_id} not found")
        self._leaf_id = entry_id

    def reset_leaf(self) -> None:
        """把叶节点重置为空根（导航到首条记录之前）。"""
        self._leaf_id = None

    def branch_with_summary(
        self,
        from_id: str | None,
        summary: str,
        *,
        details: object | None = None,
        from_hook: bool | None = None,
        usage: Mapping[str, Any] | None = None,
    ) -> str:
        """在指定位置追加分支摘要并作为新叶节点。"""
        if from_id is not None and from_id not in self._by_id:
            raise KeyError(f"Entry {from_id} not found")
        self._leaf_id = from_id
        fields: JsonObject = {
            "fromId": from_id or "root",
            "summary": summary,
        }
        if details is not None:
            fields["details"] = deepcopy(details)
        if from_hook is not None:
            fields["fromHook"] = from_hook
        if usage is not None:
            fields["usage"] = deepcopy(dict(usage))
        return self._append("branch_summary", **fields)

    def get_branch(self, from_id: str | None | object = _LATEST_LEAF) -> list[SessionEntry]:
        leaf = self._leaf_id if from_id is _LATEST_LEAF else from_id
        return deepcopy(build_session_path(self.get_entries(), leaf, by_id=self._by_id))

    def build_context_entries(self) -> list[SessionEntry]:
        return deepcopy(build_context_entries(self.get_entries(), self._leaf_id, by_id=self._by_id))

    def build_session_context(self) -> JsonObject:
        return build_session_context(self.get_entries(), self._leaf_id, by_id=self._by_id)

    def build_web_session_context(self) -> JsonObject:
        return build_session_context_with_entry_ids(self.get_entries(), self._leaf_id, by_id=self._by_id)

    def get_tree(self) -> list[JsonObject]:
        """构建会话树：按 parentId 组织节点，带标签信息，供 Web 分支导航。"""
        nodes = {
            entry_id: {
                "entry": deepcopy(entry),
                "children": [],
                **({"label": self._labels[entry_id][0], "labelTimestamp": self._labels[entry_id][1]} if entry_id in self._labels else {}),
            }
            for entry_id, entry in self._by_id.items()
        }
        roots: list[JsonObject] = []
        for entry_id, entry in self._by_id.items():
            node = nodes[entry_id]
            parent_id = entry.get("parentId")
            if parent_id is None or parent_id == entry_id or parent_id not in nodes:
                roots.append(node)
            else:
                nodes[parent_id]["children"].append(node)
        stack = list(roots)
        while stack:
            node = stack.pop()
            node["children"].sort(key=lambda item: str(item["entry"].get("timestamp", "")))
            stack.extend(node["children"])
        return roots

    def create_branched_session(self, leaf_id: str) -> Path | None:
        """Replace this manager with a new session containing one selected path.

        中文说明：以指定叶节点为终点，把这条路径复制成一个新会话文件，
        当前 manager 原地切换为新会话。
        """

        if leaf_id not in self._by_id:
            raise KeyError(f"Entry {leaf_id} not found")
        previous_file = self._session_file
        path = build_session_path(self.get_entries(), leaf_id, by_id=self._by_id)
        retained: list[SessionEntry] = []
        parent_id: str | None = None
        for original in path:
            if original.get("type") == "label":
                continue
            entry = deepcopy(original)
            entry["parentId"] = parent_id
            retained.append(entry)
            parent_id = entry["id"]

        new_session_id = str(uuid4())
        timestamp = _iso_now()
        header: FileEntry = {
            "type": "session",
            "version": CURRENT_SESSION_VERSION,
            "id": new_session_id,
            "timestamp": timestamp,
            "cwd": str(self._cwd),
        }
        if self._persist and previous_file is not None:
            header["parentSession"] = str(previous_file)

        retained_ids = {str(entry["id"]) for entry in retained}
        for target_id, (label, label_timestamp) in self._labels.items():
            if target_id not in retained_ids:
                continue
            label_id = _new_entry_id(retained_ids)
            retained_ids.add(label_id)
            label_entry: SessionEntry = {
                "type": "label",
                "id": label_id,
                "parentId": parent_id,
                "timestamp": label_timestamp,
                "targetId": target_id,
                "label": label,
            }
            retained.append(label_entry)
            parent_id = label_id

        self._session_id = new_session_id
        self._file_entries = [header, *retained]
        if self._persist:
            if self._session_dir is None:
                raise ValueError("A persistent session requires a session directory")
            safe_time = timestamp.replace(":", "-").replace(".", "-")
            self._session_file = self._session_dir / f"{safe_time}_{new_session_id}.jsonl"
        self._rebuild_index()

        has_assistant = any(
            entry.get("type") == "message"
            and isinstance(entry.get("message"), dict)
            and entry["message"].get("role") == "assistant"
            for entry in retained
        )
        self._flushed = False
        if self._persist and has_assistant:
            if self._session_file is not None and self._session_file.exists():
                raise FileExistsError(self._session_file)
            self._rewrite_file()
            self._flushed = True
        return self._session_file if self._persist else None

    @classmethod
    def fork_from(
        cls,
        source_path: str | Path,
        target_cwd: str | Path,
        session_dir: str | Path,
        *,
        session_id: str | None = None,
    ) -> SessionManager:
        """Copy a complete source session into a new target project session.

        中文说明：把完整源会话复制为指定 cwd 下的新项目会话（跨项目 fork），
        保留全部历史记录并写入 parentSession 引用。
        """

        source = Path(source_path).resolve()
        try:
            entries = parse_session_entries(source.read_text(encoding="utf-8"))
        except OSError as error:
            raise ValueError(f"Cannot fork source session: {source}") from error
        if not entries or entries[0].get("type") != "session":
            raise ValueError(f"Cannot fork source session without a valid header: {source}")
        migrate_session_entries(entries)
        if session_id is not None:
            assert_valid_session_id(session_id)
        new_id = session_id or str(uuid4())
        timestamp = _iso_now()
        target_directory = Path(session_dir).resolve()
        target_directory.mkdir(parents=True, exist_ok=True)
        safe_time = timestamp.replace(":", "-").replace(".", "-")
        target_file = target_directory / f"{safe_time}_{new_id}.jsonl"
        header: FileEntry = {
            "type": "session",
            "version": CURRENT_SESSION_VERSION,
            "id": new_id,
            "timestamp": timestamp,
            "cwd": str(Path(target_cwd).resolve()),
            "parentSession": str(source),
        }
        manager = cls(
            cwd=Path(target_cwd),
            session_dir=target_directory,
            session_file=target_file,
            persist=True,
            file_entries=[header, *deepcopy(entries[1:])],
        )
        if target_file.exists():
            raise FileExistsError(target_file)
        manager._rewrite_file()
        manager._flushed = True
        return manager

    @staticmethod
    def list(session_dir: str | Path, *, cwd: str | Path | None = None) -> list[SessionInfo]:
        """列出目录内的会话元数据，按修改时间倒序。"""
        directory = Path(session_dir).resolve()
        expected_cwd = Path(cwd).resolve() if cwd is not None else None
        if not directory.is_dir():
            return []
        sessions: list[SessionInfo] = []
        for file_path in directory.glob("*.jsonl"):
            info = build_session_info(file_path)
            if info is None:
                continue
            if expected_cwd is not None and (not info.cwd or Path(info.cwd).resolve() != expected_cwd):
                continue
            sessions.append(info)
        sessions.sort(key=lambda item: item.modified, reverse=True)
        return sessions

    @staticmethod
    def list_all(sessions_root: str | Path, *, direct: bool = False) -> list[SessionInfo]:
        """List sessions from one custom dir or all immediate project dirs.

        中文说明：从一个自定义目录或所有一级项目子目录汇总会话列表。
        """

        root = Path(sessions_root).resolve()
        if not root.is_dir():
            return []
        if direct:
            return SessionManager.list(root)
        sessions: list[SessionInfo] = []
        for directory in root.iterdir():
            if directory.is_dir():
                sessions.extend(SessionManager.list(directory))
        sessions.sort(key=lambda item: item.modified, reverse=True)
        return sessions

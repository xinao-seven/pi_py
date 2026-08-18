"""Create bounded context summaries when merging independent Sessions.

中文说明：会话合并：把来源会话中目标会话没有的独有记录，
生成有界的可读摘要，作为 custom_message 追加到目标会话。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
from typing import Any

from pi_coding_agent import SessionManager

MAX_MERGE_ITEMS = 30
MAX_ITEM_CHARS = 700
MAX_SUMMARY_CHARS = 16_000
MERGE_CUSTOM_TYPE = "session_merge_summary"


@dataclass(frozen=True, slots=True)
class MergeSummary:
    """合并摘要：文本内容、来源独有记录数与展开条目数。"""
    content: str
    source_unique_entry_count: int
    summarized_item_count: int


def create_session_merge_summary(
    source: SessionManager,
    target: SessionManager,
) -> MergeSummary | None:
    """计算合并摘要：目标会话没有的记录视为独有，逐条转成摘要行；
    无独有内容返回 None。"""
    source_entries = source.get_entries()
    target_ids = {
        entry["id"]
        for entry in target.get_entries()
        if isinstance(entry.get("id"), str)
    }
    unique = [
        entry
        for entry in source_entries
        if isinstance(entry.get("id"), str) and entry["id"] not in target_ids
    ]
    # 独有记录转成可读描述，最多展开 MAX_MERGE_ITEMS 条
    items = [
        description
        for entry in unique
        if (description := _describe_entry(entry)) is not None
    ][:MAX_MERGE_ITEMS]
    if not items:
        return None
    label = source.get_session_name() or _first_user_text(source_entries) or source.session_id
    lines = [
        "【分支会话合并摘要】",
        "",
        f"来源会话：{label}",
        f"合并时间：{datetime.now(timezone.utc).isoformat()}",
        "",
        "以下内容来自另一个独立会话副本，已合并为当前会话后续上下文：",
        "",
        *(f"{index}. {item}" for index, item in enumerate(items, 1)),
    ]
    omitted = max(0, len(unique) - len(items))
    if omitted:
        lines.extend(["", f"另有 {omitted} 条来源记录未展开。"])
    return MergeSummary(
        _truncate("\n".join(lines), MAX_SUMMARY_CHARS, normalize=False),
        len(unique),
        len(items),
    )


def append_merge_summary(
    target: SessionManager,
    source_session_id: str,
    summary: MergeSummary,
) -> str:
    """把合并摘要以 custom_message 追加到目标会话并返回 entryId。"""
    return target.append_custom_message(
        MERGE_CUSTOM_TYPE,
        summary.content,
        display=True,
        details={
            "sourceSessionId": source_session_id,
            "sourceUniqueEntryCount": summary.source_unique_entry_count,
            "summarizedItemCount": summary.summarized_item_count,
        },
    )


def _describe_entry(entry: dict[str, Any]) -> str | None:
    """把一条记录转成一行摘要；toolResult 不单独描述。"""
    entry_type = entry.get("type")
    if entry_type == "message" and isinstance(entry.get("message"), dict):
        message = entry["message"]
        role = message.get("role")
        if role == "toolResult":
            return None
        text = _content_text(message.get("content"))
        if role == "user" and text:
            return f"用户：{_truncate(text, MAX_ITEM_CHARS)}"
        if role == "assistant":
            if text:
                return f"助手：{_truncate(text, MAX_ITEM_CHARS)}"
            names = {
                str(block.get("name"))
                for block in message.get("content", [])
                if isinstance(block, dict)
                and block.get("type") == "toolCall"
                and block.get("name")
            }
            return f"助手调用工具：{', '.join(sorted(names))}" if names else None
        if role == "custom" and text:
            return f"自定义消息：{_truncate(text, MAX_ITEM_CHARS)}"
        return None
    if entry_type == "custom_message":
        text = _content_text(entry.get("content"))
        return f"自定义消息：{_truncate(text, MAX_ITEM_CHARS)}" if text else None
    if entry_type == "compaction" and isinstance(entry.get("summary"), str):
        return f"压缩摘要：{_truncate(entry['summary'], MAX_ITEM_CHARS)}"
    if entry_type == "branch_summary" and isinstance(entry.get("summary"), str):
        return f"分支摘要：{_truncate(entry['summary'], MAX_ITEM_CHARS)}"
    return None


def _first_user_text(entries: list[dict[str, Any]]) -> str | None:
    for entry in entries:
        if entry.get("type") != "message" or not isinstance(entry.get("message"), dict):
            continue
        message = entry["message"]
        if message.get("role") == "user" and (text := _content_text(message.get("content"))):
            return _truncate(text, 80)
    return None


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(block.get("text", "")).strip()
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
    ).strip()


def _truncate(text: str, limit: int, *, normalize: bool = True) -> str:
    """按字符数截断（可选压缩空白）。"""
    value = re.sub(r"\s+", " ", text).strip() if normalize else text.strip()
    if len(value) <= limit:
        return value
    return value[: limit - 3].rstrip() + "..."

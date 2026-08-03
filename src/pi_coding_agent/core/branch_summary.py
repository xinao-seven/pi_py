"""Summarize an abandoned session-tree branch while navigating elsewhere.

中文说明：分支摘要。当用户从会话树的一个分支跳到另一个分支时，
可把被遗弃分支的内容交给摘要器生成 checkpoint，跳回时上下文不丢失。
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Protocol

from pi_ai.providers.base import LLMProvider
from pi_ai.utils import estimate_message_tokens
from pi_coding_agent.core.compaction import SUMMARY_SYSTEM_PROMPT
from pi_coding_agent.core.session_manager import SessionEntry, SessionManager, session_entry_to_context_messages

BRANCH_SUMMARY_PREAMBLE = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n"
BRANCH_SUMMARY_FORMAT = """Create a concise branch checkpoint using this structure:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps

Preserve exact file paths, function names, and error messages."""


@dataclass(frozen=True, slots=True)
class BranchSummary:
    """分支摘要产物：摘要文本、可选 usage 与细节。"""
    text: str
    usage: dict[str, Any] | None = None
    details: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class BranchPreparation:
    """分支摘要准备结果：被遗弃分支的记录、消息、公共祖先与 token 预算内内容。"""
    entries: tuple[SessionEntry, ...]
    messages: tuple[dict[str, Any], ...]
    common_ancestor_id: str | None
    total_tokens: int


class BranchSummarizer(Protocol):
    # 分支摘要器协议
    async def summarize(
        self,
        messages: list[dict[str, Any]],
        *,
        custom_instructions: str | None = None,
    ) -> BranchSummary: ...


class ProviderBranchSummarizer:
    """用当前 Provider 生成分支摘要的实现。"""
    def __init__(self, provider: LLMProvider, model: str, *, thinking_level: str = "off") -> None:
        self.provider = provider
        self.model = model
        self.thinking_level = thinking_level

    async def summarize(
        self,
        messages: list[dict[str, Any]],
        *,
        custom_instructions: str | None = None,
    ) -> BranchSummary:
        """把被遗弃分支消息序列化后请求摘要，返回带固定前言的文本。"""
        conversation = json.dumps(messages, ensure_ascii=False, indent=2)
        prompt = f"<conversation>\n{conversation}\n</conversation>\n\n{BRANCH_SUMMARY_FORMAT}"
        if custom_instructions:
            prompt += f"\n\nAdditional focus: {custom_instructions}"
        parts: list[str] = []
        usage: dict[str, Any] | None = None
        error: str | None = None
        async for event in self.provider.stream(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            tools=[],
            thinking_level=self.thinking_level,
            system_prompt=SUMMARY_SYSTEM_PROMPT,
        ):
            if event.get("type") == "text_delta":
                parts.append(str(event.get("text", "")))
            elif event.get("type") == "done":
                if isinstance(event.get("usage"), dict):
                    usage = dict(event["usage"])
                if event.get("error"):
                    error = str(event["error"])
        if error:
            raise RuntimeError(f"Branch summarization failed: {error}")
        text = "".join(parts).strip()
        if not text:
            raise RuntimeError("Branch summarization returned no text")
        return BranchSummary(BRANCH_SUMMARY_PREAMBLE + text, usage)


def prepare_branch_summary(
    session: SessionManager,
    old_leaf_id: str | None,
    target_id: str,
    *,
    token_budget: int = 0,
) -> BranchPreparation:
    """计算新旧分支的公共祖先，收集旧分支上需要摘要的消息；
    token_budget>0 时从尾部向前累计，超出预算即停止（保留最近内容优先）。"""
    if old_leaf_id is None:
        return BranchPreparation((), (), None, 0)
    # 旧分支的节点 id 集合与目标分支路径求交集，得到公共祖先
    old_ids = {entry["id"] for entry in session.get_branch(old_leaf_id)}
    target_path = session.get_branch(target_id)
    common = next((entry["id"] for entry in reversed(target_path) if entry["id"] in old_ids), None)
    collected: list[SessionEntry] = []
    # 从旧叶向上走到公共祖先，收集被遗弃的记录
    current: str | None = old_leaf_id
    while current is not None and current != common:
        entry = session.get_entry(current)
        if entry is None:
            break
        collected.append(entry)
        parent = entry.get("parentId")
        current = parent if isinstance(parent, str) else None
    collected.reverse()

    messages: list[dict[str, Any]] = []
    total = 0
    for entry in reversed(collected):
        candidates = _summary_messages(entry)
        tokens = sum(estimate_message_tokens(message) for message in candidates)
        if token_budget > 0 and total + tokens > token_budget:
            break
        messages[0:0] = candidates
        total += tokens
    return BranchPreparation(tuple(collected), tuple(messages), common, total)


def _summary_messages(entry: SessionEntry) -> list[dict[str, Any]]:
    """取记录的可摘要消息；toolResult 不单独摘要（会跟随其回合上下文）。"""
    if entry.get("type") == "message":
        message = entry.get("message")
        if isinstance(message, dict) and message.get("role") == "toolResult":
            return []
    return session_entry_to_context_messages(entry)

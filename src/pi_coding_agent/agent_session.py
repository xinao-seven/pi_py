"""Coding-specific assembly of the generic Agent and persistent Session.

中文说明：把通用 AgentRuntime 组装成“编程助手”：接入 SessionManager 持久化、
工作区工具、Skills/模板/项目指令等资源，并编排 compaction 与分支摘要。
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from typing import Any, Literal

from pi_agent.agent import Agent
from pi_agent.tool_registry import ToolRegistry
from pi_ai.providers.base import LLMProvider
from pi_ai.utils import RetryPolicy
from pi_coding_agent.core.branch_summary import (
    BranchSummarizer,
    ProviderBranchSummarizer,
    prepare_branch_summary,
)
from pi_coding_agent.core.compaction import (
    CompactionSettings,
    CompactionSummarizer,
    ProviderCompactionSummarizer,
    is_context_overflow,
    prepare_compaction,
    should_compact,
)
from pi_coding_agent.core.prompt_templates import expand_prompt_template
from pi_coding_agent.core.resource_loader import CodingResourceLoader, CodingResources
from pi_coding_agent.core.session_manager import SessionManager
from pi_coding_agent.core.skills import expand_skill_command
from pi_coding_agent.core.system_prompt import build_system_prompt
from pi_coding_agent.core.usage import get_session_stats, get_usage_cost_breakdown


class AgentSession(Agent):
    """编程助手会话：通用 Agent + Session 持久化 + 编程资源 + 压缩/分支摘要。

    对外与 Agent 同接口（prompt/steer/follow_up/abort 等），但会在发送前
    展开 /skill: 命令与 /模板 命令，并在回合结束时自动判断是否需要压缩上下文。
    """
    def __init__(
        self,
        *,
        provider: LLMProvider,
        model: str,
        session_manager: SessionManager,
        tool_registry: ToolRegistry,
        system_prompt: str = "",
        thinking_level: str = "off",
        tool_execution: Literal["sequential", "parallel"] = "parallel",
        retry_policy: RetryPolicy | None = RetryPolicy(),
        context_window: int = 0,
        compaction_settings: CompactionSettings | None = None,
        compaction_summarizer: CompactionSummarizer | None = None,
        branch_summarizer: BranchSummarizer | None = None,
        branch_summary_reserve_tokens: int = 16_384,
        resource_loader: CodingResourceLoader | None = None,
    ) -> None:
        # compaction：上下文超阈值时自动压缩；branch summary：切换分支时可保留被遗弃分支的摘要
        self.session_manager = session_manager
        self.compaction_settings = compaction_settings
        self.compaction_summarizer = compaction_summarizer
        self.is_compacting = False
        self._compaction_task: asyncio.Task[Any] | None = None
        # 溢出恢复标记：上下文超限后只允许压缩并重试一次，避免递归
        self._overflow_recovery_active = False
        self.branch_summarizer = branch_summarizer
        self.branch_summary_reserve_tokens = max(0, branch_summary_reserve_tokens)
        self.is_summarizing_branch = False
        self._branch_summary_task: asyncio.Task[Any] | None = None
        self.resource_loader = resource_loader or CodingResourceLoader(session_manager.cwd)
        # 加载工作区资源（AGENTS.md、Skills、prompts、.pi/SYSTEM.md 等）
        self.resources = self.resource_loader.load()
        # 用户显式传入的 system prompt 优先于资源目录里的 .pi/SYSTEM.md
        self._custom_system_prompt = system_prompt or None
        self._initial_tool_names = tool_registry.active_names()
        # 在调用父类前先组装完整系统提示（含工具列表、项目指令与技能清单）
        assembled_system_prompt = self._build_system_prompt()
        super().__init__(
            provider=provider,
            model=model,
            session=session_manager,
            tools=tool_registry,
            system_prompt=assembled_system_prompt,
            thinking_level=thinking_level,
            tool_execution=tool_execution,
            retry_policy=retry_policy,
            context_window=context_window,
        )

    @property
    def skills(self):
        """当前加载的 Skills 集合（供 UI/配置面板读取）。"""
        return self.resources.skills

    @property
    def prompt_templates(self):
        """当前加载的 Markdown 提示模板集合。"""
        return self.resources.prompt_templates

    def reload_resources(self) -> CodingResources:
        """重新加载工作区资源（Skills/模板/项目指令），并重建系统提示。"""
        self.resources = self.resource_loader.reload()
        self.system_prompt = self._build_system_prompt()
        return self.resources

    def set_active_tools(self, names: list[str]) -> None:
        super().set_active_tools(names)
        # 工具集合变化会影响 system prompt 里的可用工具列表，需要同步重建
        self.system_prompt = self._build_system_prompt()

    async def prompt(self, content: str | list[dict[str, Any]]) -> None:
        await super().prompt(self._expand_content(content))

    async def steer(self, content: str | list[dict[str, Any]]) -> None:
        await super().steer(self._expand_content(content))

    async def follow_up(self, content: str | list[dict[str, Any]]) -> None:
        await super().follow_up(self._expand_content(content))

    def _expand_content(self, content: str | list[dict[str, Any]]) -> str | list[dict[str, Any]]:
        """发送前展开输入：文本（或文本块）先展开 /skill: 与 /模板 命令。"""
        if isinstance(content, str):
            return self._expand_prompt(content)
        expanded = deepcopy(content)
        for block in expanded:
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                block["text"] = self._expand_prompt(block["text"])
        return expanded

    def _expand_prompt(self, text: str) -> str:
        """依次展开 skill 命令与 prompt 模板命令。"""
        expanded = expand_skill_command(text, self.resources.skills)
        return expand_prompt_template(expanded, self.resources.prompt_templates)

    def _build_system_prompt(self) -> str:
        """组装完整系统提示：自定义/默认提示 + 可用工具 + 项目指令 + 技能清单。"""
        custom = self._custom_system_prompt or self.resources.system_prompt
        return build_system_prompt(
            cwd=self.session_manager.cwd,
            selected_tools=self.tools.active_names() if hasattr(self, "tools") else self._initial_tool_names,
            context_files=self.resources.context_files,
            skills=self.resources.skills,
            custom_prompt=custom,
            append_prompt=self.resources.append_system_prompt,
        )

    async def compact(
        self,
        *,
        reason: Literal["manual", "threshold", "overflow"] = "manual",
        custom_instructions: str | None = None,
    ) -> dict[str, Any] | None:
        """压缩上下文：把旧消息交给摘要器生成 checkpoint，保留最近消息。
        reason 区分手动 / 阈值触发 / 溢出恢复，便于 UI 展示。"""
        if self.is_compacting:
            raise RuntimeError("Compaction is already running")
        settings = self.compaction_settings or CompactionSettings()
        preparation = prepare_compaction(self.session_manager.get_branch(), settings)
        await super()._emit("compaction_start", reason=reason)
        if preparation is None:
            await super()._emit("compaction_end", reason=reason, result=None, aborted=False)
            return None
        summarizer = self.compaction_summarizer or ProviderCompactionSummarizer(
            self.provider,
            self.model,
            thinking_level=self.thinking_level,
        )
        self.is_compacting = True
        self._compaction_task = asyncio.current_task()
        try:
            summary = await summarizer.summarize(
                deepcopy(preparation.messages_to_summarize),
                previous_summary=preparation.previous_summary,
                custom_instructions=custom_instructions,
            )
            entry_id = self.session_manager.append_compaction(
                summary.text,
                preparation.first_kept_entry_id,
                preparation.tokens_before,
                usage=summary.usage,
            )
            self.messages = self.session_manager.build_session_context()["messages"]
            result = {
                "summary": summary.text,
                "firstKeptEntryId": preparation.first_kept_entry_id,
                "tokensBefore": preparation.tokens_before,
                "entryId": entry_id,
            }
            await super()._emit(
                "compaction_end",
                reason=reason,
                result=deepcopy(result),
                aborted=False,
                contextUsage=self.get_context_usage(),
            )
            return result
        except asyncio.CancelledError:
            await super()._emit("compaction_end", reason=reason, result=None, aborted=True)
            raise
        except Exception as exception:
            await super()._emit(
                "compaction_end",
                reason=reason,
                result=None,
                aborted=False,
                error=str(exception),
            )
            raise
        finally:
            self.is_compacting = False
            self._compaction_task = None

    async def abort_compaction(self) -> None:
        """取消正在进行的压缩（如果有）。"""
        task = self._compaction_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    async def navigate_tree(
        self,
        target_id: str,
        *,
        summarize: bool = False,
        custom_instructions: str | None = None,
        label: str | None = None,
    ) -> dict[str, Any]:
        """Move to a session-tree entry, optionally preserving the abandoned branch.

        中文说明：跳转到会话树中的某个节点；可把被遗弃分支生成摘要写回，
        并自动定位用户消息的父节点以便恢复编辑文本。
        """
        if self.is_summarizing_branch:
            raise RuntimeError("Branch summarization is already running")
        old_leaf_id = self.session_manager.leaf_id
        if target_id == old_leaf_id:
            return {"cancelled": False, "newLeafId": target_id, "summaryEntry": None}
        target = self.session_manager.get_entry(target_id)
        if target is None:
            raise KeyError(f"Entry {target_id} not found")

        token_budget = 0
        if self.context_window > 0:
            token_budget = max(0, self.context_window - self.branch_summary_reserve_tokens)
        preparation = prepare_branch_summary(
            self.session_manager,
            old_leaf_id,
            target_id,
            token_budget=token_budget,
        )
        await super()._emit(
            "branch_summary_start",
            oldLeafId=old_leaf_id,
            targetId=target_id,
            commonAncestorId=preparation.common_ancestor_id,
            summarize=summarize,
        )

        summary = None
        if summarize and preparation.messages:
            # 需要保留被遗弃分支：调用分支摘要器（可用当前 Provider）
            summarizer = self.branch_summarizer or ProviderBranchSummarizer(
                self.provider,
                self.model,
                thinking_level=self.thinking_level,
            )
            self.is_summarizing_branch = True
            self._branch_summary_task = asyncio.current_task()
            try:
                summary = await summarizer.summarize(
                    deepcopy(list(preparation.messages)),
                    custom_instructions=custom_instructions,
                )
            except asyncio.CancelledError:
                await super()._emit(
                    "branch_summary_end",
                    oldLeafId=old_leaf_id,
                    targetId=target_id,
                    result=None,
                    aborted=True,
                )
                return {"cancelled": True, "aborted": True, "summaryEntry": None}
            except Exception as exception:
                await super()._emit(
                    "branch_summary_end",
                    oldLeafId=old_leaf_id,
                    targetId=target_id,
                    result=None,
                    aborted=False,
                    error=str(exception),
                )
                raise
            finally:
                self.is_summarizing_branch = False
                self._branch_summary_task = None

        new_leaf_id = target_id
        editor_text: str | None = None
        if target.get("type") == "message" and isinstance(target.get("message"), dict):
            if target["message"].get("role") == "user":
                # 跳转到用户消息时，叶节点是其父节点，编辑框恢复该消息文本
                new_leaf_id = _parent_id(target)
                editor_text = _content_text(target["message"].get("content"))
        elif target.get("type") == "custom_message":
            new_leaf_id = _parent_id(target)
            editor_text = _content_text(target.get("content"))

        summary_entry = None
        if summary is not None:
            # 生成了分支摘要：在目标位置追加 branch_summary 条目作为新叶
            summary_id = self.session_manager.branch_with_summary(
                new_leaf_id,
                summary.text,
                details=summary.details,
                usage=summary.usage,
            )
            summary_entry = self.session_manager.get_entry(summary_id)
            new_leaf_id = summary_id
            if label:
                self.session_manager.append_label_change(summary_id, label)
                new_leaf_id = self.session_manager.leaf_id
        else:
            if new_leaf_id is None:
                self.session_manager.reset_leaf()
            else:
                self.session_manager.branch(new_leaf_id)
            if label:
                self.session_manager.append_label_change(target_id, label)
                new_leaf_id = self.session_manager.leaf_id

        self.messages = self.session_manager.build_session_context()["messages"]
        result = {
            "cancelled": False,
            "newLeafId": new_leaf_id,
            "editorText": editor_text,
            "summaryEntry": summary_entry,
        }
        await super()._emit(
            "session_tree",
            oldLeafId=old_leaf_id,
            newLeafId=new_leaf_id,
            summaryEntry=deepcopy(summary_entry),
        )
        await super()._emit(
            "branch_summary_end",
            oldLeafId=old_leaf_id,
            targetId=target_id,
            result=deepcopy(result),
            aborted=False,
        )
        return result

    async def abort_branch_summary(self) -> None:
        """取消正在进行的分支摘要（如果有）。"""
        task = self._branch_summary_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    def get_session_stats(self) -> dict[str, Any]:
        """返回 Session 的消息/token/成本统计（供 UI 展示）。"""
        return get_session_stats(
            self.session_manager.get_entries(),
            session_id=self.session_manager.session_id,
            session_file=self.session_manager.session_file,
            context_usage=self.get_context_usage(),
        )

    def get_usage_cost_breakdown(self) -> list[dict[str, Any]]:
        """返回按 provider/model 分组的成本明细。"""
        return get_usage_cost_breakdown(self.session_manager.get_entries())

    async def _emit(self, event_type: str, **payload: Any) -> None:
        await super()._emit(event_type, **payload)
        if (
            event_type == "turn_end"
            and self.compaction_settings is not None
            and not self.is_compacting
        ):
            # 回合结束后检查上下文占用，超过阈值自动触发压缩
            usage = self.get_context_usage()
            if usage and should_compact(
                int(usage["tokens"]),
                self.context_window,
                self.compaction_settings,
            ):
                try:
                    await self.compact(reason="threshold")
                except Exception:
                    # compaction_end already carries the user-visible failure.
                    pass

    async def _provider_turn_with_retry(
        self,
        new_messages: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """在父类重试逻辑之上处理上下文溢出：压缩后重新执行一次 Provider 轮次。"""
        assistant, tool_calls = await super()._provider_turn_with_retry(new_messages)
        if (
            self._overflow_recovery_active
            or not is_context_overflow(assistant, self.context_window)
        ):
            return assistant, tool_calls
        if self.messages and self.messages[-1] is assistant:
            self.messages.pop()
        self._overflow_recovery_active = True
        try:
            try:
                result = await self.compact(reason="overflow")
            except Exception:
                return assistant, tool_calls
            if result is None:
                return assistant, tool_calls
            self.messages = [
                message
                for message in self.messages
                if not (
                    message.get("role") == "assistant"
                    and message.get("stopReason") in {"error", "aborted"}
                )
            ]
            return await super()._provider_turn_with_retry(new_messages)
        finally:
            self._overflow_recovery_active = False


def _parent_id(entry: dict[str, Any]) -> str | None:
    parent = entry.get("parentId")
    return parent if isinstance(parent, str) else None


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        str(block.get("text", ""))
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )

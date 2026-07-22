"""Coding-specific assembly of the generic Agent and persistent Session."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from typing import Any, Literal

from pi_agent.agent import Agent
from pi_agent.tool_registry import ToolRegistry
from pi_ai.providers.base import LLMProvider
from pi_ai.utils import RetryPolicy
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


class AgentSession(Agent):
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
        resource_loader: CodingResourceLoader | None = None,
    ) -> None:
        self.session_manager = session_manager
        self.compaction_settings = compaction_settings
        self.compaction_summarizer = compaction_summarizer
        self.is_compacting = False
        self._compaction_task: asyncio.Task[Any] | None = None
        self._overflow_recovery_active = False
        self.resource_loader = resource_loader or CodingResourceLoader(session_manager.cwd)
        self.resources = self.resource_loader.load()
        self._custom_system_prompt = system_prompt or None
        self._initial_tool_names = tool_registry.active_names()
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
        return self.resources.skills

    @property
    def prompt_templates(self):
        return self.resources.prompt_templates

    def reload_resources(self) -> CodingResources:
        self.resources = self.resource_loader.reload()
        self.system_prompt = self._build_system_prompt()
        return self.resources

    def set_active_tools(self, names: list[str]) -> None:
        super().set_active_tools(names)
        self.system_prompt = self._build_system_prompt()

    async def prompt(self, text: str) -> None:
        await super().prompt(self._expand_prompt(text))

    async def steer(self, text: str) -> None:
        await super().steer(self._expand_prompt(text))

    async def follow_up(self, text: str) -> None:
        await super().follow_up(self._expand_prompt(text))

    def _expand_prompt(self, text: str) -> str:
        expanded = expand_skill_command(text, self.resources.skills)
        return expand_prompt_template(expanded, self.resources.prompt_templates)

    def _build_system_prompt(self) -> str:
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
        task = self._compaction_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    async def _emit(self, event_type: str, **payload: Any) -> None:
        await super()._emit(event_type, **payload)
        if (
            event_type == "turn_end"
            and self.compaction_settings is not None
            and self.compaction_summarizer is not None
            and not self.is_compacting
        ):
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

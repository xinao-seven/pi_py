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
from pi_coding_agent.core.session_manager import SessionManager


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
    ) -> None:
        self.session_manager = session_manager
        self.compaction_settings = compaction_settings
        self.compaction_summarizer = compaction_summarizer
        self.is_compacting = False
        self._compaction_task: asyncio.Task[Any] | None = None
        self._overflow_recovery_active = False
        super().__init__(
            provider=provider,
            model=model,
            session=session_manager,
            tools=tool_registry,
            system_prompt=system_prompt,
            thinking_level=thinking_level,
            tool_execution=tool_execution,
            retry_policy=retry_policy,
            context_window=context_window,
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

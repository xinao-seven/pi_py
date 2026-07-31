from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from pi_ai import FakeProvider
from pi_agent import ToolRegistry
from pi_coding_agent import AgentSession, CompactionSettings, CompactionSummary, SessionManager
from pi_coding_agent.core.compaction import ProviderCompactionSummarizer, prepare_compaction


def run(coroutine):
    return asyncio.run(coroutine)


class StubSummarizer:
    def __init__(self, text: str = "checkpoint") -> None:
        self.text = text
        self.calls: list[dict[str, Any]] = []

    async def summarize(
        self,
        messages: list[dict[str, Any]],
        *,
        previous_summary: str | None = None,
        custom_instructions: str | None = None,
    ) -> CompactionSummary:
        self.calls.append(
            {
                "messages": messages,
                "previousSummary": previous_summary,
                "customInstructions": custom_instructions,
            }
        )
        return CompactionSummary(self.text, {"input": 10, "output": 2, "totalTokens": 12})


class BlockingSummarizer:
    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def summarize(self, messages, **kwargs) -> CompactionSummary:
        del messages, kwargs
        self.started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


def _assistant(text: str, *, usage: dict[str, int] | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "provider": "fake",
        "model": "fake",
        "stopReason": "stop",
    }
    if usage:
        message["usage"] = usage
    return message


def test_preparation_keeps_complete_recent_turn_and_tool_pair(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    manager.append_message({"role": "user", "content": "old request"})
    manager.append_message(
        {
            "role": "assistant",
            "content": [{"type": "toolCall", "id": "call-1", "name": "read", "arguments": {}}],
            "provider": "fake",
            "model": "fake",
            "stopReason": "toolUse",
        }
    )
    manager.append_message(
        {
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "read",
            "content": [{"type": "text", "text": "old result"}],
            "isError": False,
        }
    )
    recent_id = manager.append_message({"role": "user", "content": "recent"})
    manager.append_message(_assistant("answer"))

    preparation = prepare_compaction(
        manager.get_branch(), CompactionSettings(reserve_tokens=1, keep_recent_tokens=1)
    )

    assert preparation is not None
    assert preparation.first_kept_entry_id == recent_id
    assert [message["role"] for message in preparation.messages_to_summarize] == [
        "user",
        "assistant",
        "toolResult",
    ]
    assert [message["role"] for message in preparation.retained_tail] == ["user", "assistant"]


def test_manual_compaction_appends_v3_entry_and_refreshes_context(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    manager.append_message({"role": "user", "content": "old request"})
    manager.append_message(_assistant("old answer"))
    manager.append_message({"role": "user", "content": "recent request"})
    manager.append_message(_assistant("recent answer"))
    summarizer = StubSummarizer()
    runtime = AgentSession(
        provider=FakeProvider([]),
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
        compaction_settings=CompactionSettings(reserve_tokens=1, keep_recent_tokens=1),
        compaction_summarizer=summarizer,
    )
    events: list[dict[str, Any]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    result = run(runtime.compact(custom_instructions="focus on files"))

    assert result is not None
    assert result["summary"] == "checkpoint"
    assert summarizer.calls[0]["customInstructions"] == "focus on files"
    assert [message["role"] for message in runtime.messages] == [
        "compactionSummary",
        "user",
        "assistant",
    ]
    compaction = manager.get_entries()[-1]
    assert compaction["type"] == "compaction"
    assert compaction["usage"]["totalTokens"] == 12
    assert [event["type"] for event in events] == ["compaction_start", "compaction_end"]


def test_threshold_compaction_runs_after_successful_turn(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    manager.append_message({"role": "user", "content": "old request"})
    manager.append_message(_assistant("old answer"))
    summarizer = StubSummarizer("automatic checkpoint")
    provider = FakeProvider(
        [[{"type": "text_delta", "text": "new answer"}, {"type": "done", "stop_reason": "stop", "usage": {"totalTokens": 18}}]]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
        context_window=20,
        compaction_settings=CompactionSettings(reserve_tokens=5, keep_recent_tokens=1),
        compaction_summarizer=summarizer,
    )
    events: list[dict[str, Any]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    run(runtime.prompt("new request"))

    assert len(summarizer.calls) == 1
    end = next(event for event in events if event["type"] == "compaction_end")
    assert end["reason"] == "threshold"
    assert runtime.messages[0]["role"] == "compactionSummary"


def test_threshold_compaction_uses_current_provider_without_injected_summarizer(
    tmp_path: Path,
) -> None:
    manager = SessionManager.in_memory(tmp_path)
    manager.append_message({"role": "user", "content": "old request"})
    manager.append_message(_assistant("old answer"))
    provider = FakeProvider(
        [
            [
                {"type": "text_delta", "text": "new answer"},
                {"type": "done", "stop_reason": "stop", "usage": {"totalTokens": 18}},
            ],
            [
                {"type": "text_delta", "text": "dynamic checkpoint"},
                {"type": "done", "stop_reason": "stop"},
            ],
        ]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
        context_window=20,
        compaction_settings=CompactionSettings(reserve_tokens=5, keep_recent_tokens=1),
    )

    run(runtime.prompt("new request"))

    assert len(provider.requests) == 2
    assert provider.requests[1]["tools"] == []
    assert provider.requests[1]["model"] == "fake"
    assert runtime.messages[0]["role"] == "compactionSummary"
    assert runtime.messages[0]["summary"] == "dynamic checkpoint"


def test_context_overflow_compacts_once_and_retries_provider(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    manager.append_message({"role": "user", "content": "old request"})
    manager.append_message(_assistant("old answer"))
    summarizer = StubSummarizer("overflow checkpoint")
    provider = FakeProvider(
        [
            [{"type": "done", "stop_reason": "error", "error": "maximum context length exceeded"}],
            [{"type": "text_delta", "text": "recovered"}, {"type": "done", "stop_reason": "stop"}],
        ]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
        context_window=1000,
        compaction_settings=CompactionSettings(reserve_tokens=100, keep_recent_tokens=1),
        compaction_summarizer=summarizer,
    )
    events: list[dict[str, Any]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    run(runtime.prompt("new request"))

    assert len(provider.requests) == 2
    assert len(summarizer.calls) == 1
    assert provider.requests[1]["messages"][0]["role"] == "compactionSummary"
    assert all(message.get("stopReason") != "error" for message in provider.requests[1]["messages"])
    assert runtime.messages[-1]["content"] == [{"type": "text", "text": "recovered"}]
    assert any(event["type"] == "compaction_end" and event["reason"] == "overflow" for event in events)


def test_provider_summarizer_uses_dedicated_prompt_without_tools() -> None:
    provider = FakeProvider(
        [[{"type": "text_delta", "text": "summary"}, {"type": "done", "stop_reason": "stop", "usage": {"totalTokens": 9}}]]
    )
    summarizer = ProviderCompactionSummarizer(provider, "fake")

    result = run(summarizer.summarize([{"role": "user", "content": "hello"}]))

    assert result == CompactionSummary("summary", {"totalTokens": 9})
    assert provider.requests[0]["tools"] == []
    assert provider.requests[0]["systemPrompt"].startswith("You are a context summarization assistant")


def test_manual_compaction_can_be_aborted(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    manager.append_message({"role": "user", "content": "old request"})
    manager.append_message(_assistant("old answer"))
    manager.append_message({"role": "user", "content": "recent request"})
    manager.append_message(_assistant("recent answer"))
    summarizer = BlockingSummarizer()
    runtime = AgentSession(
        provider=FakeProvider([]),
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
        compaction_settings=CompactionSettings(reserve_tokens=1, keep_recent_tokens=1),
        compaction_summarizer=summarizer,
    )
    events: list[dict[str, Any]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    async def scenario() -> None:
        task = asyncio.create_task(runtime.compact())
        await summarizer.started.wait()
        await runtime.abort_compaction()
        try:
            await task
        except asyncio.CancelledError:
            pass

    run(scenario())

    assert runtime.is_compacting is False
    assert events[-1] == {
        "type": "compaction_end",
        "reason": "manual",
        "result": None,
        "aborted": True,
    }

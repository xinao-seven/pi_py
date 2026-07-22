from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from pi_agent import ToolRegistry
from pi_ai import FakeProvider
from pi_coding_agent import AgentSession, BranchSummary, SessionManager
from pi_coding_agent.core.branch_summary import prepare_branch_summary


def run(coroutine):
    return asyncio.run(coroutine)


def _assistant(text: str) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "provider": "fake",
        "model": "fake",
        "stopReason": "stop",
    }


class StubBranchSummarizer:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def summarize(self, messages, *, custom_instructions=None) -> BranchSummary:
        self.calls.append({"messages": messages, "customInstructions": custom_instructions})
        return BranchSummary(
            "branch checkpoint",
            {"input": 8, "output": 2, "cost": {"total": 0.01}},
            {"source": "test"},
        )


class BlockingBranchSummarizer:
    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def summarize(self, messages, **kwargs) -> BranchSummary:
        del messages, kwargs
        self.started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


def test_prepare_branch_summary_collects_abandoned_path_and_skips_tool_results(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    target_id = manager.append_message({"role": "user", "content": "start"})
    manager.append_message(_assistant("use tool"))
    manager.append_message(
        {
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "read",
            "content": [{"type": "text", "text": "result"}],
            "isError": False,
        }
    )
    manager.append_message({"role": "user", "content": "continue"})
    old_leaf_id = manager.append_message(_assistant("done"))

    preparation = prepare_branch_summary(manager, old_leaf_id, target_id)

    assert preparation.common_ancestor_id == target_id
    assert len(preparation.entries) == 4
    assert [message["role"] for message in preparation.messages] == ["assistant", "user", "assistant"]
    assert preparation.total_tokens > 0


def test_navigate_tree_summarizes_old_branch_and_restores_user_text(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    target_id = manager.append_message({"role": "user", "content": "original prompt"})
    manager.append_message(_assistant("first answer"))
    manager.append_message({"role": "user", "content": "follow branch"})
    manager.append_message(_assistant("branch answer"))
    summarizer = StubBranchSummarizer()
    runtime = AgentSession(
        provider=FakeProvider([]),
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
        branch_summarizer=summarizer,
    )
    events: list[dict[str, Any]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    result = run(
        runtime.navigate_tree(
            target_id,
            summarize=True,
            custom_instructions="keep filenames",
        )
    )

    assert result["cancelled"] is False
    assert result["editorText"] == "original prompt"
    assert result["summaryEntry"]["type"] == "branch_summary"
    assert result["summaryEntry"]["parentId"] is None
    assert result["summaryEntry"]["usage"]["input"] == 8
    assert summarizer.calls[0]["customInstructions"] == "keep filenames"
    assert [message["role"] for message in runtime.messages] == ["branchSummary"]
    assert [event["type"] for event in events] == [
        "branch_summary_start",
        "session_tree",
        "branch_summary_end",
    ]


def test_navigate_tree_without_summary_moves_to_selected_assistant(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    manager.append_message({"role": "user", "content": "one"})
    target_id = manager.append_message(_assistant("answer one"))
    manager.append_message({"role": "user", "content": "two"})
    manager.append_message(_assistant("answer two"))
    runtime = AgentSession(
        provider=FakeProvider([]),
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
    )

    result = run(runtime.navigate_tree(target_id))

    assert result["newLeafId"] == target_id
    assert result["summaryEntry"] is None
    assert [message["role"] for message in runtime.messages] == ["user", "assistant"]


def test_abort_branch_summary_returns_cancelled_result(tmp_path: Path) -> None:
    manager = SessionManager.in_memory(tmp_path)
    target_id = manager.append_message({"role": "user", "content": "start"})
    manager.append_message(_assistant("answer"))
    blocker = BlockingBranchSummarizer()
    runtime = AgentSession(
        provider=FakeProvider([]),
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
        branch_summarizer=blocker,
    )

    async def scenario() -> dict[str, Any]:
        task = asyncio.create_task(runtime.navigate_tree(target_id, summarize=True))
        await blocker.started.wait()
        await runtime.abort_branch_summary()
        return await task

    result = run(scenario())

    assert result == {"cancelled": True, "aborted": True, "summaryEntry": None}
    assert runtime.is_summarizing_branch is False
    assert manager.leaf_id != target_id

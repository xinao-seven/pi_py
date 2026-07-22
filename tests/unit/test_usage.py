from pathlib import Path
from typing import Any

import pytest

from pi_agent import ToolRegistry
from pi_ai import FakeProvider
from pi_coding_agent import AgentSession, SessionManager
from pi_coding_agent.core.usage import get_session_stats, get_usage_cost_breakdown


def _assistant_with_tool_call() -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": [
            {"type": "text", "text": "checking"},
            {"type": "toolCall", "id": "call-1", "name": "read", "arguments": {}},
            {"type": "toolCall", "id": "call-2", "name": "bash", "arguments": {}},
        ],
        "provider": "fake-provider",
        "model": "requested-model",
        "responseModel": "actual-model",
        "stopReason": "toolUse",
        "usage": {
            "input": 10,
            "output": 5,
            "cacheRead": 2,
            "cacheWrite": 1,
            "cost": {"total": 0.02},
        },
    }


def _populated_session(tmp_path: Path) -> SessionManager:
    manager = SessionManager.in_memory(tmp_path, session_id="usage-session")
    manager.append_message({"role": "user", "content": "inspect"})
    assistant_id = manager.append_message(_assistant_with_tool_call())
    manager.append_message(
        {
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "read",
            "content": [{"type": "text", "text": "ok"}],
            "isError": False,
            "usage": {
                "input": 1,
                "output": 1,
                "cost": {"total": 0.01},
            },
        }
    )
    manager.append_compaction(
        "compact checkpoint",
        assistant_id,
        18,
        usage={"input": 3, "output": 2, "cost": {"total": 0.005}},
    )
    manager.branch_with_summary(
        manager.leaf_id,
        "branch checkpoint",
        usage={"input": 2, "output": 1, "cost": {"total": 0.004}},
    )
    return manager


def test_session_stats_include_all_append_only_entries(tmp_path: Path) -> None:
    manager = _populated_session(tmp_path)

    stats = get_session_stats(
        manager.get_entries(),
        session_id=manager.session_id,
        session_file=manager.session_file,
        context_usage={"tokens": 3, "contextWindow": 100, "percent": 3.0},
    )

    assert stats["sessionId"] == "usage-session"
    assert stats["sessionFile"] is None
    assert stats["userMessages"] == 1
    assert stats["assistantMessages"] == 1
    assert stats["toolResults"] == 1
    assert stats["toolCalls"] == 2
    assert stats["totalMessages"] == 3
    assert stats["tokens"] == {
        "input": 16,
        "output": 9,
        "cacheRead": 2,
        "cacheWrite": 1,
        "total": 28,
    }
    assert stats["cost"] == pytest.approx(0.039)
    assert stats["contextUsage"]["tokens"] == 3


def test_usage_breakdown_groups_models_separately_from_tools_and_summaries(tmp_path: Path) -> None:
    breakdown = get_usage_cost_breakdown(_populated_session(tmp_path).get_entries())

    assert breakdown == [
        {"key": "fake-provider/actual-model", "cost": 0.02, "tokens": 18},
        {"key": "Tools/summaries", "cost": pytest.approx(0.019), "tokens": 10},
    ]


def test_agent_session_exposes_current_stats_and_breakdown(tmp_path: Path) -> None:
    manager = _populated_session(tmp_path)
    runtime = AgentSession(
        provider=FakeProvider([]),
        model="fake",
        session_manager=manager,
        tool_registry=ToolRegistry(),
        context_window=100,
    )

    stats = runtime.get_session_stats()
    breakdown = runtime.get_usage_cost_breakdown()

    assert stats["sessionId"] == "usage-session"
    assert stats["tokens"]["total"] == 28
    assert stats["contextUsage"] is not None
    assert breakdown[0]["key"] == "fake-provider/actual-model"

import asyncio
from pathlib import Path

from pi_agent import ToolRegistry
from pi_ai import FakeProvider
from pi_coding_agent import AgentSession, SessionManager, create_builtin_tools


def run(coroutine):
    return asyncio.run(coroutine)


def test_agent_runs_provider_tool_provider_loop_and_persists(tmp_path: Path) -> None:
    (tmp_path / "note.txt").write_text("hello from tool", encoding="utf-8")
    provider = FakeProvider([
        [
            {"type": "thinking_delta", "text": "I should read. "},
            {"type": "tool_call_start", "id": "call-1", "name": "read"},
            {"type": "tool_call_delta", "id": "call-1", "arguments": '{"path":"note.txt"}'},
            {"type": "done", "stop_reason": "toolUse", "usage": {"input": 10, "output": 2}},
        ],
        [
            {"type": "text_delta", "text": "The file says: "},
            {"type": "text_delta", "text": "hello from tool"},
            {"type": "done", "stop_reason": "stop", "usage": {"input": 20, "output": 5}},
        ],
    ])
    session = SessionManager.in_memory(tmp_path, session_id="agent-loop")
    runtime = AgentSession(
        provider=provider,
        model="fake-model",
        session_manager=session,
        tool_registry=ToolRegistry(create_builtin_tools(tmp_path)),
        system_prompt="You are a test agent.",
    )
    events: list[dict[str, object]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    run(runtime.prompt("Read the note"))

    assert len(provider.requests) == 2
    assert provider.requests[1]["messages"][-1]["role"] == "toolResult"
    assert provider.requests[1]["messages"][-1]["content"][0]["text"] == "hello from tool"
    roles = [message["role"] for message in runtime.messages]
    assert roles == ["user", "assistant", "toolResult", "assistant"]
    assert runtime.messages[-1]["content"] == [{"type": "text", "text": "The file says: hello from tool"}]
    assert [event["type"] for event in events].count("tool_execution_start") == 1
    assert events[0]["type"] == "agent_start"
    assert events[-1]["type"] == "agent_end"
    assert session.build_session_context()["messages"] == runtime.messages


def test_steer_message_is_injected_before_agent_stops(tmp_path: Path) -> None:
    provider = FakeProvider([
        [{"type": "text_delta", "text": "first"}, {"type": "done", "stop_reason": "stop"}],
        [{"type": "text_delta", "text": "steered"}, {"type": "done", "stop_reason": "stop"}],
    ])
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry(),
    )
    queued = False

    async def listener(event) -> None:
        nonlocal queued
        if event.type == "message_update" and not queued:
            queued = True
            await runtime.steer("change direction")

    runtime.subscribe(listener)
    run(runtime.prompt("start"))

    assert len(provider.requests) == 2
    assert provider.requests[1]["messages"][-1]["content"] == "change direction"
    assert runtime.messages[-1]["content"][0]["text"] == "steered"


def test_follow_up_runs_after_a_completed_turn(tmp_path: Path) -> None:
    provider = FakeProvider([
        [{"type": "text_delta", "text": "answer"}, {"type": "done", "stop_reason": "stop"}],
        [{"type": "text_delta", "text": "followed"}, {"type": "done", "stop_reason": "stop"}],
    ])
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry(),
    )
    queued = False

    async def listener(event) -> None:
        nonlocal queued
        if event.type == "message_update" and not queued:
            queued = True
            await runtime.follow_up("one more thing")

    runtime.subscribe(listener)
    run(runtime.prompt("start"))

    assert provider.requests[1]["messages"][-1]["content"] == "one more thing"


def test_abort_cancels_provider_and_emits_terminal_event(tmp_path: Path) -> None:
    provider = FakeProvider([[{"type": "delay", "seconds": 5}, {"type": "text_delta", "text": "late"}]])
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry(),
    )
    events: list[dict[str, object]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    async def scenario() -> None:
        task = asyncio.create_task(runtime.prompt("start"))
        await asyncio.sleep(0.05)
        await runtime.abort()
        await task

    run(scenario())

    assert runtime.is_streaming is False
    assert events[-1]["type"] == "agent_end"
    assert events[-1]["aborted"] is True

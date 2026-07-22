import asyncio
from pathlib import Path

from pi_agent import AgentTool, ToolRegistry, ToolResult
from pi_ai import FakeProvider, RetryPolicy
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


def test_parallel_tools_overlap_but_result_messages_keep_call_order(tmp_path: Path) -> None:
    both_started = asyncio.Event()
    started: set[str] = set()

    def make_tool(name: str, delay: float) -> AgentTool:
        async def execute(_arguments) -> ToolResult:
            started.add(name)
            if len(started) == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=0.5)
            await asyncio.sleep(delay)
            return ToolResult.text(name)

        return AgentTool(
            name=name,
            label=name,
            description=name,
            input_schema={"type": "object"},
            execute=execute,
            execution_mode="parallel",
        )

    provider = FakeProvider(
        [
            [
                {"type": "tool_call_start", "id": "call-a", "name": "a", "arguments": {}},
                {"type": "tool_call_start", "id": "call-b", "name": "b", "arguments": {}},
                {"type": "done", "stop_reason": "toolUse"},
            ],
            [{"type": "text_delta", "text": "done"}, {"type": "done", "stop_reason": "stop"}],
        ]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry([make_tool("a", 0.03), make_tool("b", 0.0)]),
    )
    events: list[dict[str, object]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    run(asyncio.wait_for(runtime.prompt("run both"), timeout=1.0))

    end_ids = [event["toolCallId"] for event in events if event["type"] == "tool_execution_end"]
    result_ids = [message["toolCallId"] for message in runtime.messages if message["role"] == "toolResult"]
    assert end_ids == ["call-b", "call-a"]
    assert result_ids == ["call-a", "call-b"]


def test_one_sequential_tool_makes_the_whole_batch_sequential(tmp_path: Path) -> None:
    active = 0
    max_active = 0
    execution_order: list[str] = []

    def make_tool(name: str, mode: str) -> AgentTool:
        async def execute(_arguments) -> ToolResult:
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            execution_order.append(f"start:{name}")
            await asyncio.sleep(0.01)
            execution_order.append(f"end:{name}")
            active -= 1
            return ToolResult.text(name)

        return AgentTool(
            name=name,
            label=name,
            description=name,
            input_schema={"type": "object"},
            execute=execute,
            execution_mode=mode,
        )

    provider = FakeProvider(
        [
            [
                {"type": "tool_call_start", "id": "call-a", "name": "a", "arguments": {}},
                {"type": "tool_call_start", "id": "call-b", "name": "b", "arguments": {}},
                {"type": "done", "stop_reason": "toolUse"},
            ],
            [{"type": "done", "stop_reason": "stop"}],
        ]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry([make_tool("a", "parallel"), make_tool("b", "sequential")]),
    )

    run(runtime.prompt("run in order"))

    assert max_active == 1
    assert execution_order == ["start:a", "end:a", "start:b", "end:b"]


def test_global_sequential_mode_overrides_parallel_tools(tmp_path: Path) -> None:
    active = 0
    max_active = 0

    def make_tool(name: str) -> AgentTool:
        async def execute(_arguments) -> ToolResult:
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.01)
            active -= 1
            return ToolResult.text(name)

        return AgentTool(
            name=name,
            label=name,
            description=name,
            input_schema={"type": "object"},
            execute=execute,
            execution_mode="parallel",
        )

    provider = FakeProvider(
        [
            [
                {"type": "tool_call_start", "id": "call-a", "name": "a", "arguments": {}},
                {"type": "tool_call_start", "id": "call-b", "name": "b", "arguments": {}},
                {"type": "done", "stop_reason": "toolUse"},
            ],
            [{"type": "done", "stop_reason": "stop"}],
        ]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry([make_tool("a"), make_tool("b")]),
        tool_execution="sequential",
    )

    run(runtime.prompt("run sequentially"))

    assert max_active == 1


def test_retryable_provider_error_retries_without_polluting_live_context(tmp_path: Path) -> None:
    provider = FakeProvider(
        [
            [{"type": "done", "stop_reason": "error", "error": "503 service unavailable"}],
            [
                {"type": "text_delta", "text": "recovered"},
                {"type": "done", "stop_reason": "stop", "usage": {"totalTokens": 25}},
            ],
        ]
    )
    session = SessionManager.in_memory(tmp_path)
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=session,
        tool_registry=ToolRegistry(),
        retry_policy=RetryPolicy(max_retries=2, base_delay_seconds=0),
        context_window=100,
    )
    events: list[dict[str, object]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    run(runtime.prompt("retry"))

    assert len(provider.requests) == 2
    assert [message["role"] for message in provider.requests[1]["messages"]] == ["user"]
    assert [message["role"] for message in runtime.messages] == ["user", "assistant"]
    assert runtime.messages[-1]["content"] == [{"type": "text", "text": "recovered"}]
    assert [event["type"] for event in events if event["type"].startswith("auto_retry")] == [
        "auto_retry_start",
        "auto_retry_end",
    ]
    retry_end = next(event for event in events if event["type"] == "auto_retry_end")
    assert retry_end["success"] is True
    assert runtime.get_context_usage() == {"tokens": 25, "contextWindow": 100, "percent": 25.0}
    turn_end = next(event for event in events if event["type"] == "turn_end")
    assert turn_end["contextUsage"] == runtime.get_context_usage()
    assert [message["stopReason"] for message in session.build_session_context()["messages"] if message["role"] == "assistant"] == [
        "error",
        "stop",
    ]


def test_non_retryable_billing_error_fails_immediately(tmp_path: Path) -> None:
    provider = FakeProvider(
        [[{"type": "done", "stop_reason": "error", "error": "429 insufficient_quota billing"}]]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry(),
        retry_policy=RetryPolicy(max_retries=3, base_delay_seconds=0),
    )
    events: list[dict[str, object]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    run(runtime.prompt("do not retry"))

    assert len(provider.requests) == 1
    assert not any(event["type"] == "auto_retry_start" for event in events)
    assert events[-1]["error"] == "429 insufficient_quota billing"


def test_abort_during_retry_backoff_emits_retry_end(tmp_path: Path) -> None:
    provider = FakeProvider(
        [[{"type": "done", "stop_reason": "error", "error": "overloaded"}]]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry(),
        retry_policy=RetryPolicy(max_retries=3, base_delay_seconds=5),
    )
    events: list[dict[str, object]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    async def scenario() -> None:
        task = asyncio.create_task(runtime.prompt("retry then abort"))
        while not runtime.is_retrying:
            await asyncio.sleep(0)
        await runtime.abort()
        await task

    run(scenario())

    retry_end = next(event for event in events if event["type"] == "auto_retry_end")
    assert retry_end["success"] is False
    assert retry_end["finalError"] == "Retry cancelled"
    assert events[-1]["aborted"] is True


def test_retry_budget_is_bounded_and_reports_final_error(tmp_path: Path) -> None:
    provider = FakeProvider(
        [
            [{"type": "done", "stop_reason": "error", "error": "503 first"}],
            [{"type": "done", "stop_reason": "error", "error": "503 second"}],
            [{"type": "done", "stop_reason": "error", "error": "503 final"}],
        ]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry(),
        retry_policy=RetryPolicy(max_retries=2, base_delay_seconds=0),
    )
    events: list[dict[str, object]] = []
    runtime.subscribe(lambda event: events.append(event.to_dict()))

    run(runtime.prompt("exhaust retries"))

    starts = [event for event in events if event["type"] == "auto_retry_start"]
    assert [event["attempt"] for event in starts] == [1, 2]
    assert len(provider.requests) == 3
    retry_end = next(event for event in events if event["type"] == "auto_retry_end")
    assert retry_end == {
        "type": "auto_retry_end",
        "success": False,
        "attempt": 2,
        "finalError": "503 final",
    }

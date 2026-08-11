"""End-to-end approval gate tests through the HTTP + SSE API.

中文说明：危险命令人工确认的 ASGI 全链路测试：FakeProvider 发起危险命令 →
收到 tool_call_pending 事件 → 通过 approve_tool 命令允许/拒绝 → 断言
工具是否真正执行。全程离线，不访问网络。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from pi_ai import FakeProvider
from server.config import ServerSettings
from server.main import create_app
from server.services.agent_bridge import event_stream


def _dangerous_command(target: Path) -> str:
    # PowerShell 的递归强制删除；Windows 下真实可用
    return f'Remove-Item -Recurse -Force "{target}"'


def _tool_turn(command: str) -> list[dict]:
    return [
        {"type": "tool_call_start", "id": "call-1", "name": "bash", "arguments": {}},
        {
            "type": "tool_call_delta",
            "id": "call-1",
            "arguments": json.dumps({"command": command}),
        },
        {"type": "done", "stop_reason": "tool_use"},
    ]


def _text_turn(text: str) -> list[dict]:
    return [
        {"type": "text_delta", "text": text},
        {"type": "done", "stop_reason": "stop"},
    ]


async def _drain(stream, events: list[dict]) -> None:
    """把 event_stream 的所有事件追加进共享列表（边收边读，供轮询断言）。"""
    async for frame in stream:
        if frame.startswith(":"):
            continue
        try:
            data = frame.split("data: ", 1)[1]
        except IndexError:
            continue
        events.append(json.loads(data))


async def _wait_for_event(
    events: list[dict],
    event_type: str,
    *,
    timeout: float = 5.0,
) -> dict:
    """轮询共享事件列表直到出现指定类型，返回该事件。"""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        for event in events:
            if event["type"] == event_type:
                return event
        await asyncio.sleep(0.01)
    raise AssertionError(f"event {event_type!r} not observed within {timeout}s")


async def _run_agent(
    tmp_path: Path,
    command: str,
    *,
    tool_names: list[str] = ["bash"],
) -> tuple[object, httpx.AsyncClient, list[dict], asyncio.Task, str]:
    """创建 Agent 并发起命令，返回 client、共享事件列表、drain 任务与 session_id。"""
    provider = FakeProvider([_tool_turn(command), _text_turn("command finished")])
    app = create_app(
        ServerSettings(
            sessions_dir=tmp_path / "sessions",
            own_config_dir=tmp_path / "agent-python",
            idle_timeout_seconds=60,
        ),
        provider_resolver=lambda name: provider,
    )
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")
    created = await client.post(
        "/api/agent/new",
        json={
            "cwd": str(tmp_path),
            "message": "delete the target directory",
            "provider": "fake",
            "modelId": "fake-model",
            "toolNames": tool_names,
        },
    )
    session_id = created.json()["sessionId"]
    entry = app.state.agent_registry.get(session_id)
    assert entry is not None
    stream = event_stream(entry, heartbeat_seconds=5)
    await anext(stream)  # connected
    events: list[dict] = []
    drain = asyncio.create_task(_drain(stream, events))
    return app, client, events, drain, session_id


@pytest.mark.asyncio
async def test_rejected_dangerous_command_is_blocked(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    command = _dangerous_command(target)
    app, client, events, drain, session_id = await _run_agent(tmp_path, command)

    try:
        pending = await _wait_for_event(events, "tool_call_pending")
        assert pending["toolName"] == "bash"
        assert pending["args"]["command"] == command
        assert "删除" in pending["reason"]

        response = await client.post(
            f"/api/agent/{session_id}",
            json={"type": "approve_tool", "toolCallId": pending["toolCallId"], "approved": False},
        )
        assert response.json()["data"] == {"toolCallId": "call-1", "approved": False}

        await _wait_for_event(events, "tool_execution_blocked")
        await _wait_for_event(events, "agent_end")
    finally:
        await client.aclose()
        if drain and not drain.done():
            drain.cancel()
        await app.state.agent_registry.close()

    # 命令未执行：目标目录仍在，且事件里只有 blocked、没有 tool_execution_end
    assert target.is_dir()
    event_types = [event["type"] for event in events]
    assert "tool_execution_blocked" in event_types
    assert "tool_execution_end" not in event_types


@pytest.mark.asyncio
async def test_approved_dangerous_command_executes(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    command = _dangerous_command(target)
    app, client, events, drain, session_id = await _run_agent(tmp_path, command)

    try:
        pending = await _wait_for_event(events, "tool_call_pending")
        response = await client.post(
            f"/api/agent/{session_id}",
            json={"type": "approve_tool", "toolCallId": pending["toolCallId"], "approved": True},
        )
        assert response.json()["data"] == {"toolCallId": "call-1", "approved": True}

        await _wait_for_event(events, "tool_execution_end")
        await _wait_for_event(events, "agent_end")
    finally:
        await client.aclose()
        if drain and not drain.done():
            drain.cancel()
        await app.state.agent_registry.close()

    # 命令真实执行：目标目录被删除，且没有 blocked 事件
    assert not target.exists()
    event_types = [event["type"] for event in events]
    assert "tool_execution_blocked" not in event_types
    assert any(
        event["type"] == "tool_execution_end" and not event["isError"]
        for event in events
    )


@pytest.mark.asyncio
async def test_safe_command_runs_without_pending(tmp_path: Path) -> None:
    app, client, events, drain, session_id = await _run_agent(tmp_path, "echo hello")
    try:
        await _wait_for_event(events, "tool_execution_end")
        await _wait_for_event(events, "agent_end")
    finally:
        await client.aclose()
        if drain and not drain.done():
            drain.cancel()
        await app.state.agent_registry.close()

    assert not any(event["type"] == "tool_call_pending" for event in events)


@pytest.mark.asyncio
async def test_approve_unknown_tool_call_returns_422(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    app, client, events, drain, session_id = await _run_agent(tmp_path, _dangerous_command(target))
    try:
        pending = await _wait_for_event(events, "tool_call_pending")
        response = await client.post(
            f"/api/agent/{session_id}",
            json={"type": "approve_tool", "toolCallId": "missing-call", "approved": True},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "no_pending_tool_call"

        # 拒绝真正的挂起项，避免测试结束后 agent 卡住
        await client.post(
            f"/api/agent/{session_id}",
            json={"type": "approve_tool", "toolCallId": pending["toolCallId"], "approved": False},
        )
        await _wait_for_event(events, "agent_end")
    finally:
        await client.aclose()
        if drain and not drain.done():
            drain.cancel()
        await app.state.agent_registry.close()

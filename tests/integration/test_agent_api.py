import asyncio
from pathlib import Path

import httpx
import pytest

from pi_ai import FakeProvider
from server.config import ServerSettings
from server.main import create_app
from server.services.agent_bridge import event_stream


def _provider() -> FakeProvider:
    return FakeProvider(
        [
            [
                {"type": "text_delta", "text": "hello "},
                {"type": "text_delta", "text": "from agent"},
                {
                    "type": "done",
                    "stop_reason": "stop",
                    "usage": {"input": 4, "output": 3},
                },
            ]
        ]
    )


async def _wait_until_idle(client: httpx.AsyncClient, session_id: str) -> dict:
    for _ in range(100):
        response = await client.get(f"/api/agent/{session_id}")
        state = response.json()
        if state["running"] and not state["state"]["isStreaming"]:
            return state
        await asyncio.sleep(0.01)
    raise AssertionError("Agent did not become idle")


@pytest.mark.asyncio
async def test_create_agent_runs_prompt_and_persists_session(tmp_path: Path) -> None:
    settings = ServerSettings(
        sessions_dir=tmp_path / "sessions",
        idle_timeout_seconds=60,
    )
    app = create_app(settings, provider_resolver=lambda name: _provider())
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/agent/new",
            json={
                "cwd": str(tmp_path),
                "message": "hello",
                "provider": "fake",
                "modelId": "fake-model",
                "toolNames": [],
            },
        )
        session_id = created.json()["sessionId"]
        state = await _wait_until_idle(client, session_id)
        detail = await client.get(f"/api/sessions/{session_id}")
        tools = await client.post(f"/api/agent/{session_id}", json={"type": "get_tools"})

    assert created.status_code == 202
    assert state["state"]["sessionStats"]["assistantMessages"] == 1
    assert [message["role"] for message in detail.json()["context"]["messages"]] == [
        "user",
        "assistant",
    ]
    assert detail.json()["context"]["messages"][-1]["content"][0]["text"] == "hello from agent"
    assert tools.json()["data"]["activeTools"] == []
    await app.state.agent_registry.close()


@pytest.mark.asyncio
async def test_event_stream_replays_events_and_honors_event_cursor(tmp_path: Path) -> None:
    app = create_app(
        ServerSettings(sessions_dir=tmp_path / "sessions", idle_timeout_seconds=60),
        provider_resolver=lambda name: _provider(),
    )
    registry = app.state.agent_registry
    entry = await registry.create(
        cwd=tmp_path,
        provider_name="fake",
        model="fake-model",
        tool_names=[],
    )
    entry.start(entry.agent.prompt("hello"))
    while entry.agent.is_streaming or not entry.agent.messages:
        await asyncio.sleep(0.01)

    stream = event_stream(entry, heartbeat_seconds=1)
    connected = await anext(stream)
    first_event = await anext(stream)
    first_id = int(first_event.splitlines()[0].removeprefix("id: "))
    await stream.aclose()

    resumed = event_stream(entry, heartbeat_seconds=1, after_event_id=first_id)
    await anext(resumed)
    next_event = await anext(resumed)
    next_id = int(next_event.splitlines()[0].removeprefix("id: "))
    await resumed.aclose()

    assert '"type":"connected"' in connected
    assert next_id > first_id
    await registry.close()


@pytest.mark.asyncio
async def test_invalid_workspace_and_unknown_command_return_api_errors(tmp_path: Path) -> None:
    app = create_app(
        ServerSettings(sessions_dir=tmp_path / "sessions"),
        provider_resolver=lambda name: _provider(),
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        invalid = await client.post(
            "/api/agent/new",
            json={"cwd": str(tmp_path / "missing"), "message": "hello"},
        )
        created = await client.post(
            "/api/agent/new",
            json={"cwd": str(tmp_path), "message": "hello", "provider": "fake"},
        )
        unknown = await client.post(
            f"/api/agent/{created.json()['sessionId']}",
            json={"type": "explode"},
        )

    assert invalid.status_code == 400
    assert invalid.json()["error"]["code"] == "invalid_workspace"
    assert unknown.status_code == 422
    assert unknown.json()["error"]["code"] == "unsupported_command"
    await app.state.agent_registry.close()

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
async def test_create_agent_accepts_image_only_content_and_persists_blocks(tmp_path: Path) -> None:
    provider = _provider()
    app = create_app(
        ServerSettings(sessions_dir=tmp_path / "sessions", idle_timeout_seconds=60),
        provider_resolver=lambda name: provider,
    )
    transport = httpx.ASGITransport(app=app)
    image = {"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"}

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/agent/new",
            json={
                "cwd": str(tmp_path),
                "message": "",
                "images": [image],
                "provider": "fake",
                "modelId": "fake-model",
                "toolNames": [],
            },
        )
        session_id = created.json()["sessionId"]
        await _wait_until_idle(client, session_id)
        detail = await client.get(f"/api/sessions/{session_id}")

    assert created.status_code == 202
    assert provider.requests[0]["messages"][0]["content"] == [image]
    assert detail.json()["context"]["messages"][0]["content"] == [image]
    await app.state.agent_registry.close()


@pytest.mark.asyncio
async def test_create_agent_rejects_invalid_image_content(tmp_path: Path) -> None:
    app = create_app(
        ServerSettings(sessions_dir=tmp_path / "sessions"),
        provider_resolver=lambda name: _provider(),
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/agent/new",
            json={
                "cwd": str(tmp_path),
                "images": [{"type": "image", "data": "not-base64", "mimeType": "image/png"}],
            },
        )

    assert response.status_code == 422
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


@pytest.mark.asyncio
async def test_model_switch_restores_provider_and_context_window(tmp_path: Path) -> None:
    agent_dir = tmp_path / "agent"
    providers = {
        "alpha": FakeProvider(
            [[{"type": "text_delta", "text": "alpha"}, {"type": "done", "stop_reason": "stop"}]]
        ),
        "beta": FakeProvider(
            [[{"type": "text_delta", "text": "beta"}, {"type": "done", "stop_reason": "stop"}]]
        ),
    }
    providers["alpha"].name = "alpha"
    providers["beta"].name = "beta"
    app = create_app(
        ServerSettings(
            agent_dir=agent_dir,
            sessions_dir=tmp_path / "sessions",
            default_provider="alpha",
            default_model="alpha-model",
            idle_timeout_seconds=60,
        ),
        provider_resolver=lambda name: providers[name],
    )
    app.state.model_config.write(
        {
            "providers": {
                "alpha": {
                    "models": [{"id": "alpha-model", "contextWindow": 100000}]
                },
                "beta": {
                    "models": [{"id": "beta-model", "contextWindow": 200000}]
                },
            }
        }
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/agent/new",
            json={
                "cwd": str(tmp_path),
                "message": "first",
                "provider": "alpha",
                "modelId": "alpha-model",
                "toolNames": [],
            },
        )
        session_id = created.json()["sessionId"]
        await _wait_until_idle(client, session_id)
        switched = await client.post(
            f"/api/agent/{session_id}",
            json={"type": "set_model", "provider": "beta", "modelId": "beta-model"},
        )
        active_state = await client.get(f"/api/agent/{session_id}")
        await app.state.agent_registry.remove(session_id)
        resumed = await client.post(
            f"/api/agent/{session_id}",
            json={"type": "prompt", "message": "after restart"},
        )
        restored_state = await _wait_until_idle(client, session_id)
        detail = await client.get(f"/api/sessions/{session_id}")

    assert switched.json()["data"]["model"] == {
        "provider": "beta",
        "modelId": "beta-model",
        "contextWindow": 200000,
    }
    assert active_state.json()["state"]["contextUsage"]["contextWindow"] == 200000
    assert resumed.status_code == 200
    assert restored_state["state"]["model"] == {
        "provider": "beta",
        "modelId": "beta-model",
    }
    assert restored_state["state"]["contextUsage"]["contextWindow"] == 200000
    assert providers["beta"].requests[0]["model"] == "beta-model"
    assert detail.json()["context"]["model"] == {
        "provider": "beta",
        "modelId": "beta-model",
    }
    await app.state.agent_registry.close()


@pytest.mark.asyncio
async def test_agent_registry_injects_global_resources(tmp_path: Path) -> None:
    agent_dir = tmp_path / "agent"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (agent_dir / "prompts").mkdir(parents=True)
    (agent_dir / "skills" / "global-skill").mkdir(parents=True)
    (agent_dir / "AGENTS.md").write_text("global agent instruction", encoding="utf-8")
    (agent_dir / "prompts" / "global.md").write_text(
        "expanded global prompt: $1",
        encoding="utf-8",
    )
    (agent_dir / "skills" / "global-skill" / "SKILL.md").write_text(
        "---\nname: global-skill\ndescription: A global test skill\n---\nUse global behavior.\n",
        encoding="utf-8",
    )
    provider = FakeProvider(
        [[{"type": "text_delta", "text": "ok"}, {"type": "done", "stop_reason": "stop"}]]
    )
    app = create_app(
        ServerSettings(
            agent_dir=agent_dir,
            sessions_dir=tmp_path / "sessions",
            idle_timeout_seconds=60,
        ),
        provider_resolver=lambda name: provider,
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        created = await client.post(
            "/api/agent/new",
            json={
                "cwd": str(workspace),
                "message": "/global selected",
                "provider": "fake",
                "modelId": "fake-model",
                "toolNames": ["read"],
            },
        )
        await _wait_until_idle(client, created.json()["sessionId"])

    request = provider.requests[0]
    assert request["messages"][-1]["content"] == "expanded global prompt: selected"
    assert "global agent instruction" in request["systemPrompt"]
    assert "global-skill" in request["systemPrompt"]
    await app.state.agent_registry.close()

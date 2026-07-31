"""Agent creation, commands, state, and SSE routes."""

from __future__ import annotations

from typing import Any, Annotated

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from server.config import ServerSettings
from server.errors import APIError
from server.services.agent_bridge import agent_state, event_stream, send_command
from server.services.agent_registry import (
    AgentRegistry,
    ProviderConfigurationError,
)

router = APIRouter(prefix="/api/agent", tags=["agent"])


class NewAgentRequest(BaseModel):
    cwd: str
    message: Annotated[str, Field(min_length=1)]
    provider: str | None = None
    modelId: str | None = None
    thinkingLevel: str = "off"
    toolNames: list[str] | None = None


class AgentCommandRequest(BaseModel):
    type: str
    message: str | None = None
    provider: str | None = None
    modelId: str | None = None
    thinkingLevel: str | None = None
    toolNames: list[str] | None = None
    targetId: str | None = None
    summarize: bool = False
    customInstructions: str | None = None
    label: str | None = None
    customType: str | None = None
    content: str | list[dict[str, Any]] | None = None
    display: bool = True
    details: Any = None


def get_registry(request: Request) -> AgentRegistry:
    return request.app.state.agent_registry


def get_settings(request: Request) -> ServerSettings:
    return request.app.state.settings


@router.post("/new", status_code=202)
async def create_agent(
    body: NewAgentRequest,
    registry: AgentRegistry = Depends(get_registry),
    settings: ServerSettings = Depends(get_settings),
) -> dict[str, Any]:
    from pathlib import Path

    cwd = Path(body.cwd).expanduser()
    if not cwd.is_dir():
        raise APIError(400, "invalid_workspace", f"Workspace does not exist: {body.cwd}")
    try:
        entry = await registry.create(
            cwd=cwd,
            provider_name=body.provider or settings.default_provider,
            model=body.modelId or settings.default_model,
            thinking_level=body.thinkingLevel,
            tool_names=body.toolNames,
        )
    except ProviderConfigurationError as exception:
        raise APIError(400, "provider_not_configured", str(exception)) from exception
    try:
        await send_command(entry, {"type": "prompt", "message": body.message})
    except Exception:
        await registry.remove(entry.session_id)
        raise
    return {"success": True, "sessionId": entry.session_id}


@router.post("/{session_id}")
async def command_agent(
    session_id: str,
    body: AgentCommandRequest,
    registry: AgentRegistry = Depends(get_registry),
    settings: ServerSettings = Depends(get_settings),
) -> dict[str, Any]:
    entry = registry.get(session_id)
    if entry is None:
        try:
            entry = await registry.activate(
                session_id,
                provider_name=settings.default_provider,
                model=settings.default_model,
                tool_names=body.toolNames if body.type == "set_tools" else None,
            )
        except ProviderConfigurationError as exception:
            raise APIError(400, "provider_not_configured", str(exception)) from exception
    if entry is None:
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    try:
        result = await send_command(entry, body.model_dump(exclude_none=True))
    except ProviderConfigurationError as exception:
        raise APIError(400, "provider_not_configured", str(exception)) from exception
    return {"success": True, "data": result}


@router.get("/{session_id}")
async def get_agent_state(
    session_id: str,
    registry: AgentRegistry = Depends(get_registry),
) -> dict[str, Any]:
    entry = registry.get(session_id)
    return (
        {"running": True, "state": agent_state(entry)}
        if entry is not None
        else {"running": False}
    )


@router.get("/{session_id}/events")
async def stream_agent_events(
    session_id: str,
    request: Request,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    registry: AgentRegistry = Depends(get_registry),
    settings: ServerSettings = Depends(get_settings),
) -> StreamingResponse:
    del request
    entry = registry.get(session_id)
    if entry is None:
        raise APIError(404, "agent_not_active", f"Agent {session_id!r} is not active")
    try:
        after = max(0, int(last_event_id or "0"))
    except ValueError as exception:
        raise APIError(400, "invalid_event_id", "Last-Event-ID must be an integer") from exception
    return StreamingResponse(
        event_stream(
            entry,
            heartbeat_seconds=settings.sse_heartbeat_seconds,
            after_event_id=after,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

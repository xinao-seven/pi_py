"""Agent creation, commands, state, and SSE routes.

中文说明：Agent API：创建新 Agent、统一命令入口（prompt/steer/abort/模型切换等）、
状态查询与 SSE 事件流（支持 Last-Event-ID 断点续传）。
"""

from __future__ import annotations

import base64
import binascii
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from server.config import ServerSettings
from server.errors import APIError
from server.services.agent_bridge import agent_state, event_stream, send_command
from server.services.agent_registry import (
    AgentRegistry,
    ProviderConfigurationError,
)

router = APIRouter(prefix="/api/agent", tags=["agent"])


class ImageInput(BaseModel):
    """图片输入：base64 数据 + MIME；单图不超过 5 MB。"""
    type: Literal["image"] = "image"
    data: Annotated[str, Field(min_length=1, max_length=7_000_000)]
    mimeType: Annotated[str, Field(min_length=1, max_length=100)]

    @field_validator("data")
    @classmethod
    def validate_data(cls, value: str) -> str:
        """校验 base64 有效性并限制解码后大小。"""
        try:
            decoded = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exception:
            raise ValueError("data must be valid base64") from exception
        if len(decoded) > 5 * 1024 * 1024:
            raise ValueError("image exceeds 5 MB")
        return value

    @field_validator("mimeType")
    @classmethod
    def validate_mime_type(cls, value: str) -> str:
        if not value.startswith("image/"):
            raise ValueError("mimeType must be an image type")
        return value


class NewAgentRequest(BaseModel):
    """创建 Agent 的请求：工作目录 + 首条消息/图片 + 模型与工具配置。"""
    cwd: str
    message: str = ""
    images: list[ImageInput] = Field(default_factory=list, max_length=4)
    provider: str | None = None
    modelId: str | None = None
    thinkingLevel: str = "off"
    toolNames: list[str] | None = None

    @model_validator(mode="after")
    def validate_content(self):
        if not self.message.strip() and not self.images:
            raise ValueError("message or images must be provided")
        return self


class AgentCommandRequest(BaseModel):
    """统一命令请求：type 决定命令类型，其余字段按类型可选。"""
    type: str
    message: str | None = None
    images: list[ImageInput] = Field(default_factory=list, max_length=4)
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
    """创建新会话并立即发送首条消息；启动失败会回滚删除刚建的会话。"""
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
        await send_command(
            entry,
            {
                "type": "prompt",
                "message": body.message,
                "images": [image.model_dump() for image in body.images],
            },
        )
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
    """对已有会话发送命令；会话未激活时先按历史配置激活。"""
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
    """返回 Agent 是否在运行及其详细状态。"""
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
    """SSE 事件流：从 after_event_id 之后开始回放（Last-Event-ID 续传）。"""
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

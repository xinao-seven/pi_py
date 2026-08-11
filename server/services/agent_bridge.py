"""Translate HTTP commands and Agent events.

中文说明：HTTP 与 Agent 之间的桥接：把 REST 命令翻译成 AgentSession 操作，
把 Agent 事件包装成 SSE 帧（含心跳与 Last-Event-ID 序号）。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import json
from typing import Any

from server.errors import APIError
from server.services.agent_registry import RegistryEntry


def agent_state(entry: RegistryEntry) -> dict[str, Any]:
    """汇总 Agent 当前状态（运行中标志、压缩/分支摘要/重试状态、模型、工具、用量）。"""
    agent = entry.agent
    return {
        "sessionId": entry.session_id,
        "isStreaming": agent.is_streaming,
        "isCompacting": agent.is_compacting,
        "isSummarizingBranch": agent.is_summarizing_branch,
        "isRetrying": agent.is_retrying,
        "retryAttempt": agent.retry_attempt,
        "thinkingLevel": agent.thinking_level,
        "model": {"provider": agent.provider.name, "modelId": agent.model},
        "activeTools": list(agent.tools.active_names()),
        "contextUsage": agent.get_context_usage(),
        "sessionStats": agent.get_session_stats(),
    }


async def send_command(entry: RegistryEntry, command: dict[str, Any]) -> dict[str, Any]:
    """按命令类型分发到 Agent 操作；非法命令返回 422。"""
    agent = entry.agent
    command_type = command.get("type")
    entry.touch()
    if command_type == "prompt":
        # 发起新对话：Agent 空闲时后台运行，立即返回已接受
        content = _message_content(command)
        if agent.is_streaming:
            raise APIError(409, "agent_busy", "The Agent is already running")
        entry.start(agent.prompt(content))
        return {"accepted": True}
    if command_type == "steer":
        await agent.steer(_message_content(command))
        return {"accepted": True}
    if command_type == "follow_up":
        await agent.follow_up(_message_content(command))
        return {"accepted": True}
    if command_type == "abort":
        await agent.abort()
        return {"aborted": True}
    if command_type == "approve_tool":
        # 危险命令人工确认：对挂起的工具调用给出允许/拒绝
        tool_call_id = _required_text(command, "toolCallId")
        approved = bool(command.get("approved", False))
        if not entry.tool_approval.resolve(tool_call_id, approved):
            raise APIError(
                422,
                "no_pending_tool_call",
                f"No pending tool call to approve: {tool_call_id!r}",
            )
        return {"toolCallId": tool_call_id, "approved": approved}
    if command_type == "set_model":
        provider_name = _optional_text(command.get("provider")) or agent.provider.name
        resolved = entry.set_model(provider_name, _required_text(command, "modelId"))
        return {
            "model": {
                "provider": resolved.provider,
                "modelId": resolved.model,
                "contextWindow": resolved.context_window,
            }
        }
    if command_type == "set_thinking_level":
        agent.set_thinking_level(_required_text(command, "thinkingLevel"))
        return {"thinkingLevel": agent.thinking_level}
    if command_type == "set_tools":
        names = command.get("toolNames")
        if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
            raise APIError(422, "invalid_command", "toolNames must be a list of strings")
        try:
            agent.set_active_tools(names)
        except KeyError as exception:
            raise APIError(422, "unknown_tool", str(exception)) from exception
        return {"activeTools": list(agent.tools.active_names())}
    if command_type == "get_tools":
        return {
            "activeTools": list(agent.tools.active_names()),
            "availableTools": list(agent.tools.names()),
        }
    if command_type == "get_state":
        return agent_state(entry)
    if command_type == "compact":
        result = await agent.compact(
            custom_instructions=_optional_text(command.get("customInstructions"))
        )
        return {"result": result}
    if command_type == "abort_compaction":
        await agent.abort_compaction()
        return {"aborted": True}
    if command_type == "navigate_tree":
        # 会话树导航：可附带分支摘要与标签
        target_id = _required_text(command, "targetId")
        return await agent.navigate_tree(
            target_id,
            summarize=bool(command.get("summarize", False)),
            custom_instructions=_optional_text(command.get("customInstructions")),
            label=_optional_text(command.get("label")),
        )
    if command_type == "abort_branch_summary":
        await agent.abort_branch_summary()
        return {"aborted": True}
    if command_type == "append_custom_message":
        # 追加自定义消息（如系统注入的上下文）并刷新 Agent 上下文
        custom_type = _required_text(command, "customType")
        content = command.get("content")
        if not isinstance(content, (str, list)):
            raise APIError(422, "invalid_command", "content must be text or content blocks")
        entry_id = agent.session_manager.append_custom_message(
            custom_type,
            content,
            display=bool(command.get("display", True)),
            details=command.get("details"),
        )
        agent.messages = agent.session_manager.build_session_context()["messages"]
        return {"entryId": entry_id}
    raise APIError(422, "unsupported_command", f"Unsupported Agent command: {command_type!r}")


async def event_stream(
    entry: RegistryEntry,
    *,
    heartbeat_seconds: float,
    after_event_id: int = 0,
) -> AsyncIterator[str]:
    """把订阅队列转成 SSE 帧：连接确认、id 序号、心跳注释行，断开时退订。"""
    queue, unsubscribe = entry.subscribe(after_event_id=after_event_id)
    connected = {"type": "connected", "sessionId": entry.session_id}
    yield "retry: 1000\n" + _sse_data(connected)
    try:
        while entry.alive:
            try:
                event_id, event = await asyncio.wait_for(
                    queue.get(),
                    timeout=heartbeat_seconds,
                )
                yield f"id: {event_id}\n" + _sse_data(event)
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
    except asyncio.CancelledError:
        pass
    finally:
        unsubscribe()


def _sse_data(value: dict[str, Any]) -> str:
    return f"data: {json.dumps(value, ensure_ascii=False, separators=(',', ':'))}\n\n"


def _required_text(command: dict[str, Any], key: str) -> str:
    value = command.get(key)
    if not isinstance(value, str) or not value.strip():
        raise APIError(422, "invalid_command", f"{key} must be a non-empty string")
    return value.strip()


def _message_content(command: dict[str, Any]) -> str | list[dict[str, Any]]:
    raw_message = command.get("message")
    message = raw_message.strip() if isinstance(raw_message, str) else ""
    raw_images = command.get("images", [])
    if not isinstance(raw_images, list):
        raise APIError(422, "invalid_command", "images must be a list")
    images = [
        {
            "type": "image",
            "data": image.get("data"),
            "mimeType": image.get("mimeType"),
        }
        for image in raw_images
        if isinstance(image, dict)
        and image.get("type") == "image"
        and isinstance(image.get("data"), str)
        and image.get("data")
        and isinstance(image.get("mimeType"), str)
        and image.get("mimeType", "").startswith("image/")
    ]
    if len(images) != len(raw_images):
        raise APIError(422, "invalid_command", "images contain an invalid content block")
    if not message and not images:
        raise APIError(422, "invalid_command", "message or images must be provided")
    if not images:
        return message
    return [*([{"type": "text", "text": message}] if message else []), *images]


def _optional_text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None

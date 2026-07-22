"""Provider-neutral streaming Agent loop.

This module depends only on pi_ai primitives and pi_agent abstractions. A
structural transcript store may be supplied by an application layer, but the
agent package does not import any coding-agent implementation.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import datetime, timezone
import inspect
import json
from typing import Any, Literal, Protocol

from pi_ai.providers.base import LLMProvider
from pi_ai.utils import RetryPolicy, estimate_context_tokens, is_retryable_assistant_error
from pi_agent.events import AgentEvent
from pi_agent.tool_registry import ToolRegistry
from pi_agent.types import ToolError

EventListener = Callable[[AgentEvent], None | Awaitable[None]]


class TranscriptStore(Protocol):
    def build_session_context(self) -> dict[str, Any]: ...

    def append_message(self, message: dict[str, Any]) -> str: ...

    def append_model_change(self, provider: str, model_id: str) -> str: ...

    def append_thinking_level_change(self, thinking_level: str) -> str: ...


def _timestamp_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class AgentRuntime:
    """Run prompts, provider turns, and tool calls while emitting UI events."""

    def __init__(
        self,
        *,
        provider: LLMProvider,
        model: str,
        session: TranscriptStore | None = None,
        tools: ToolRegistry,
        system_prompt: str = "",
        thinking_level: str = "off",
        tool_execution: Literal["sequential", "parallel"] = "parallel",
        retry_policy: RetryPolicy | None = None,
        context_window: int = 0,
    ) -> None:
        self.provider = provider
        self.model = model
        self.session = session
        self.tools = tools
        self.system_prompt = system_prompt
        self.thinking_level = thinking_level
        self.tool_execution = tool_execution
        self.retry_policy = retry_policy
        self.context_window = context_window
        self.messages: list[dict[str, Any]] = (
            session.build_session_context()["messages"] if session is not None else []
        )
        self._listeners: list[EventListener] = []
        self._steering: list[dict[str, Any]] = []
        self._follow_ups: list[dict[str, Any]] = []
        self._run_task: asyncio.Task[None] | None = None
        self._abort_requested = False
        self.is_streaming = False
        self.is_retrying = False
        self.retry_attempt = 0

    def subscribe(self, listener: EventListener) -> Callable[[], None]:
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    async def _emit(self, event_type: str, **payload: Any) -> None:
        event = AgentEvent(event_type, payload)
        for listener in list(self._listeners):
            result = listener(event)
            if inspect.isawaitable(result):
                await result

    def set_model(self, model: str) -> None:
        self.model = model
        if self.session is not None:
            self.session.append_model_change(self.provider.name, model)

    def set_thinking_level(self, level: str) -> None:
        self.thinking_level = level
        if self.session is not None:
            self.session.append_thinking_level_change(level)

    def set_active_tools(self, names: list[str]) -> None:
        self.tools.set_active(names)

    async def steer(self, text: str) -> None:
        if not self.is_streaming:
            raise RuntimeError("Cannot steer while the Agent is idle")
        self._steering.append(self._user_message(text))

    async def follow_up(self, text: str) -> None:
        if not self.is_streaming:
            raise RuntimeError("Cannot queue a follow-up while the Agent is idle")
        self._follow_ups.append(self._user_message(text))

    async def abort(self) -> None:
        self._abort_requested = True
        task = self._run_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    async def prompt(self, text: str) -> None:
        if self.is_streaming:
            raise RuntimeError("Agent is already running")
        if not text.strip():
            raise ValueError("Prompt must not be empty")
        self.is_streaming = True
        self._abort_requested = False
        self._run_task = asyncio.current_task()
        new_messages: list[dict[str, Any]] = []
        error: str | None = None
        await self._emit("agent_start")
        try:
            user_message = self._user_message(text)
            await self._append_message(user_message, new_messages)
            while not self._abort_requested:
                assistant, tool_calls = await self._provider_turn_with_retry(new_messages)
                if assistant.get("stopReason") == "error":
                    error = str(assistant.get("errorMessage") or "Provider error")
                    break
                tool_results = await self._execute_tools(tool_calls, new_messages)
                await self._emit(
                    "turn_end",
                    message=deepcopy(assistant),
                    toolResults=deepcopy(tool_results),
                    contextUsage=self.get_context_usage(),
                )
                steering = self._drain(self._steering)
                if steering:
                    for message in steering:
                        await self._append_message(message, new_messages)
                    continue
                if tool_calls:
                    continue
                follow_ups = self._drain(self._follow_ups, one=True)
                if follow_ups:
                    await self._append_message(follow_ups[0], new_messages)
                    continue
                break
        except asyncio.CancelledError:
            self._abort_requested = True
        except Exception as exception:
            error = str(exception)
            raise
        finally:
            await self._emit(
                "agent_end",
                messages=deepcopy(new_messages),
                aborted=self._abort_requested,
                error=error,
            )
            self.is_streaming = False
            self._run_task = None

    @staticmethod
    def _user_message(text: str) -> dict[str, Any]:
        return {"role": "user", "content": text, "timestamp": _timestamp_ms()}

    @staticmethod
    def _drain(queue: list[dict[str, Any]], *, one: bool = False) -> list[dict[str, Any]]:
        count = min(1, len(queue)) if one else len(queue)
        drained = queue[:count]
        del queue[:count]
        return drained

    async def _append_message(
        self,
        message: dict[str, Any],
        new_messages: list[dict[str, Any]],
    ) -> str:
        entry_id = self.session.append_message(message) if self.session is not None else None
        self.messages.append(message)
        new_messages.append(message)
        await self._emit("message_start", message=deepcopy(message), entryId=entry_id)
        await self._emit("message_end", message=deepcopy(message), entryId=entry_id)
        return entry_id

    async def _provider_turn(
        self,
        new_messages: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        await self._emit("turn_start")
        assistant: dict[str, Any] = {
            "role": "assistant",
            "content": [],
            "provider": self.provider.name,
            "model": self.model,
            "timestamp": _timestamp_ms(),
        }
        await self._emit("message_start", message=deepcopy(assistant))
        tool_blocks: dict[str, dict[str, Any]] = {}
        argument_buffers: dict[str, str] = {}
        usage: dict[str, Any] | None = None
        stop_reason = "stop"
        error_message: str | None = None
        async for event in self.provider.stream(
            model=self.model,
            messages=deepcopy(self.messages),
            tools=self.tools.definitions(),
            thinking_level=self.thinking_level,
            system_prompt=self.system_prompt,
        ):
            if self._abort_requested:
                raise asyncio.CancelledError
            event_type = event.get("type")
            if event_type == "text_delta":
                self._append_delta(assistant["content"], "text", "text", str(event.get("text", "")))
            elif event_type == "thinking_delta":
                self._append_delta(
                    assistant["content"], "thinking", "thinking", str(event.get("text", ""))
                )
            elif event_type == "tool_call_start":
                call_id = str(event.get("id", ""))
                block = {
                    "type": "toolCall",
                    "id": call_id,
                    "name": str(event.get("name", "")),
                    "arguments": deepcopy(event.get("arguments", {})),
                }
                if not isinstance(block["arguments"], dict):
                    block["arguments"] = {}
                assistant["content"].append(block)
                tool_blocks[call_id] = block
                argument_buffers[call_id] = ""
            elif event_type == "tool_call_delta":
                call_id = str(event.get("id", ""))
                if call_id in tool_blocks:
                    argument_buffers[call_id] += str(event.get("arguments", ""))
            elif event_type == "done":
                usage = deepcopy(event.get("usage")) if isinstance(event.get("usage"), dict) else None
                stop_reason = str(event.get("stop_reason", "stop"))
                error_message = str(event["error"]) if event.get("error") else None
            await self._emit(
                "message_update",
                message=deepcopy(assistant),
                assistantMessageEvent=deepcopy(event),
            )
        tool_calls: list[dict[str, Any]] = []
        for block in tool_blocks.values():
            raw_arguments = argument_buffers[block["id"]]
            if raw_arguments:
                try:
                    parsed = json.loads(raw_arguments)
                except json.JSONDecodeError as exception:
                    raise ToolError(f"Invalid arguments for tool {block['name']}: {exception}") from exception
                if not isinstance(parsed, dict):
                    raise ToolError(f"Arguments for tool {block['name']} must be an object")
                block["arguments"] = parsed
            tool_calls.append(block)
        assistant["stopReason"] = "error" if error_message else stop_reason
        if usage is not None:
            assistant["usage"] = usage
        if error_message:
            assistant["errorMessage"] = error_message
        entry_id = self.session.append_message(assistant) if self.session is not None else None
        self.messages.append(assistant)
        new_messages.append(assistant)
        await self._emit("message_end", message=deepcopy(assistant), entryId=entry_id)
        return assistant, tool_calls

    async def _provider_turn_with_retry(
        self,
        new_messages: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        attempt = 0
        while True:
            assistant, tool_calls = await self._provider_turn(new_messages)
            if assistant.get("stopReason") != "error":
                if attempt:
                    await self._emit("auto_retry_end", success=True, attempt=attempt)
                self.retry_attempt = 0
                return assistant, tool_calls

            policy = self.retry_policy
            if (
                policy is None
                or not policy.enabled
                or attempt >= policy.max_retries
                or not is_retryable_assistant_error(assistant)
            ):
                if attempt:
                    await self._emit(
                        "auto_retry_end",
                        success=False,
                        attempt=attempt,
                        finalError=str(assistant.get("errorMessage") or "Unknown error"),
                    )
                self.retry_attempt = 0
                return assistant, tool_calls

            attempt += 1
            self.retry_attempt = attempt
            delay = policy.delay_for_attempt(attempt)
            await self._emit(
                "auto_retry_start",
                attempt=attempt,
                maxAttempts=policy.max_retries,
                delayMs=int(delay * 1000),
                errorMessage=str(assistant.get("errorMessage") or "Unknown error"),
            )
            # Preserve the failed message in the append-only transcript while
            # excluding it from the live provider context used for the retry.
            if self.messages and self.messages[-1] is assistant:
                self.messages.pop()
            self.is_retrying = True
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                await self._emit(
                    "auto_retry_end",
                    success=False,
                    attempt=attempt,
                    finalError="Retry cancelled",
                )
                self.retry_attempt = 0
                raise
            finally:
                self.is_retrying = False

    def get_context_usage(self) -> dict[str, int | float] | None:
        if self.context_window <= 0:
            return None
        estimate = estimate_context_tokens(
            self.messages,
            system_prompt=self.system_prompt,
            tools=self.tools.definitions(),
        )
        return {
            "tokens": estimate.tokens,
            "contextWindow": self.context_window,
            "percent": estimate.tokens / self.context_window * 100,
        }

    @staticmethod
    def _append_delta(content: list[dict[str, Any]], block_type: str, field: str, delta: str) -> None:
        if content and content[-1].get("type") == block_type:
            content[-1][field] += delta
        else:
            content.append({"type": block_type, field: delta})

    async def _execute_tools(
        self,
        tool_calls: list[dict[str, Any]],
        new_messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        run_parallel = self.tool_execution == "parallel" and not any(
            self.tools.execution_mode(call["name"]) == "sequential" for call in tool_calls
        )
        if run_parallel:
            return await self._execute_tools_parallel(tool_calls, new_messages)
        return await self._execute_tools_sequential(tool_calls, new_messages)

    async def _execute_tools_sequential(
        self,
        tool_calls: list[dict[str, Any]],
        new_messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for call in tool_calls:
            await self._emit_tool_start(call)
            tool_message = await self._run_tool(call)
            await self._append_message(tool_message, new_messages)
            results.append(tool_message)
        return results

    async def _execute_tools_parallel(
        self,
        tool_calls: list[dict[str, Any]],
        new_messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        # Match pi: start events are emitted in call order, executions overlap,
        # end events follow completion order, and result messages retain call order.
        for call in tool_calls:
            await self._emit_tool_start(call)
        results = list(await asyncio.gather(*(self._run_tool(call) for call in tool_calls)))
        for tool_message in results:
            await self._append_message(tool_message, new_messages)
        return results

    async def _emit_tool_start(self, call: dict[str, Any]) -> None:
        await self._emit(
            "tool_execution_start",
            toolCallId=call["id"],
            toolName=call["name"],
            args=deepcopy(call["arguments"]),
        )

    async def _run_tool(self, call: dict[str, Any]) -> dict[str, Any]:
        call_id = call["id"]
        name = call["name"]
        arguments = call["arguments"]
        try:
            result = await self.tools.execute(call_id, name, arguments)
        except (ToolError, OSError, ValueError) as exception:
            content = [{"type": "text", "text": str(exception)}]
            details = None
            is_error = True
        else:
            content = deepcopy(result.content)
            details = deepcopy(result.details)
            is_error = result.is_error
        tool_message = {
            "role": "toolResult",
            "toolCallId": call_id,
            "toolName": name,
            "content": content,
            "isError": is_error,
            "timestamp": _timestamp_ms(),
        }
        await self._emit(
            "tool_execution_end",
            toolCallId=call_id,
            toolName=name,
            result={"content": content, "details": details},
            isError=is_error,
        )
        return tool_message

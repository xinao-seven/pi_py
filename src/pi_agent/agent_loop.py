"""Provider-neutral streaming Agent loop.

This module depends only on pi_ai primitives and pi_agent abstractions. A
structural transcript store may be supplied by an application layer, but the
agent package does not import any coding-agent implementation.

中文说明：通用 Agent 主循环，把 Provider 流式响应、工具执行、消息持久化
和 UI 事件串成一轮完整对话。为保持通用性，持久化只依赖 TranscriptStore 协议，
本包不导入任何编程助手的具体实现。
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


class ToolApprover(Protocol):
    """工具执行前的审批钩子：返回 True 放行，False 拒绝。

    中文说明：由应用层注入（如危险命令人工确认）。pi_agent 层只负责
    在工具执行前调用并信任返回值，不知道“危险命令”的具体规则。
    """

    def __call__(
        self,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> Awaitable[bool]: ...


class TranscriptStore(Protocol):
    # 转录存储协议：AgentRuntime 只依赖这四个方法，不关心底层是文件还是数据库
    def build_session_context(self) -> dict[str, Any]: ...

    def append_message(self, message: dict[str, Any]) -> str: ...

    def append_model_change(self, provider: str, model_id: str) -> str: ...

    def append_thinking_level_change(self, thinking_level: str) -> str: ...


def _timestamp_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class AgentRuntime:
    """Run prompts, provider turns, and tool calls while emitting UI events.

    中文说明：核心运行时。维护消息列表、工具注册表、Provider 与思考档位，
    对外提供 prompt / steer / follow-up / abort / set_model 等操作，
    并持续向订阅者发布 AgentEvent（消息增量、工具执行、回合结束等）。
    """

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
        tool_approver: ToolApprover | None = None,
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
        # 工具审批钩子：None 表示直接执行（默认行为）
        self.tool_approver = tool_approver
        # 从 Session 恢复的历史上下文；无 Session 时从空列表开始
        self.messages: list[dict[str, Any]] = (
            session.build_session_context()["messages"] if session is not None else []
        )
        self._listeners: list[EventListener] = []
        # 运行中的插入消息（steer）与排队消息（follow-up）
        self._steering: list[dict[str, Any]] = []
        self._follow_ups: list[dict[str, Any]] = []
        self._run_task: asyncio.Task[None] | None = None
        self._abort_requested = False
        self.is_streaming = False
        self.is_retrying = False
        self.retry_attempt = 0

    def subscribe(self, listener: EventListener) -> Callable[[], None]:
        """注册事件监听器，返回取消订阅函数。"""
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

    def set_model(
        self,
        model: str,
        *,
        provider: LLMProvider | None = None,
        context_window: int | None = None,
    ) -> None:
        """切换模型；可同时更换 Provider 与上下文窗口，并写入 Session 记录。"""
        if provider is not None:
            self.provider = provider
        self.model = model
        if context_window is not None:
            self.context_window = max(0, context_window)
        if self.session is not None:
            self.session.append_model_change(self.provider.name, model)

    def set_thinking_level(self, level: str) -> None:
        """切换思考档位并写入 Session 记录。"""
        self.thinking_level = level
        if self.session is not None:
            self.session.append_thinking_level_change(level)

    def set_active_tools(self, names: list[str]) -> None:
        """切换本轮可被模型调用的工具集合。"""
        self.tools.set_active(names)

    async def steer(self, content: str | list[dict[str, Any]]) -> None:
        """运行中插入一条消息，立即参与当前回合（只有运行时才能调用）。"""
        if not self.is_streaming:
            raise RuntimeError("Cannot steer while the Agent is idle")
        self._steering.append(self._user_message(content))

    async def follow_up(self, content: str | list[dict[str, Any]]) -> None:
        """运行中排队一条消息，在当前回合自然结束后处理。"""
        if not self.is_streaming:
            raise RuntimeError("Cannot queue a follow-up while the Agent is idle")
        self._follow_ups.append(self._user_message(content))

    async def abort(self) -> None:
        """请求中止：置位标记并取消当前运行任务。"""
        self._abort_requested = True
        task = self._run_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    async def prompt(self, content: str | list[dict[str, Any]]) -> None:
        """主入口：发起一次新的对话运行。

        追加用户消息后进入循环：调 Provider 得到助手回复与工具调用，
        执行工具并把结果写回上下文；有 steer 时插入当前回合继续，
        有工具调用时把结果交回模型推理，最后处理 follow-up，直到没有更多工作。
        """
        if self.is_streaming:
            raise RuntimeError("Agent is already running")
        normalized_content = self._normalize_user_content(content)
        self.is_streaming = True
        self._abort_requested = False
        self._run_task = asyncio.current_task()
        new_messages: list[dict[str, Any]] = []
        error: str | None = None
        await self._emit("agent_start")
        try:
            user_message = self._user_message(normalized_content)
            await self._append_message(user_message, new_messages)
            while not self._abort_requested:
                assistant, tool_calls = await self._provider_turn_with_retry(new_messages)
                if assistant.get("stopReason") == "error":
                    # Provider 出错（且不可重试）时记录错误并结束
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
                    # 有 steer：把插入消息追加进当前回合，继续推理
                    for message in steering:
                        await self._append_message(message, new_messages)
                    continue
                if tool_calls:
                    # 模型请求了工具：工具结果会作为消息写回，交给模型继续推理
                    continue
                follow_ups = self._drain(self._follow_ups, one=True)
                if follow_ups:
                    # 没有工具调用时才消费下一条 follow-up，并继续运行
                    await self._append_message(follow_ups[0], new_messages)
                    continue
                # 没有 steer / 工具调用 / follow-up：正常结束运行
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
    def _user_message(content: str | list[dict[str, Any]]) -> dict[str, Any]:
        return {"role": "user", "content": deepcopy(content), "timestamp": _timestamp_ms()}

    @staticmethod
    def _normalize_user_content(content: str | list[dict[str, Any]]) -> str | list[dict[str, Any]]:
        if isinstance(content, str):
            normalized = content.strip()
            if not normalized:
                raise ValueError("Prompt must not be empty")
            return normalized
        if not isinstance(content, list):
            raise ValueError("Prompt content must be text or content blocks")
        blocks = [deepcopy(block) for block in content if isinstance(block, dict)]
        if not blocks or not any(
            (block.get("type") == "text" and str(block.get("text", "")).strip())
            or (block.get("type") == "image" and block.get("data") and block.get("mimeType"))
            for block in blocks
        ):
            raise ValueError("Prompt must contain text or an image")
        return blocks

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
        """把消息同时写入 Session（持久化）与运行时消息列表，并发布事件。"""
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
        """执行一轮 Provider 流式调用：把归一化事件组装成 assistant 消息，
        收集工具调用（流式 JSON 参数在流结束后统一解析），并持久化 assistant 消息。"""
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
        # 工具参数以流式字符串片段累积，流结束后统一 JSON 解析
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
                # 为该工具调用初始化参数缓冲
                argument_buffers[call_id] = ""
            elif event_type == "tool_call_delta":
                call_id = str(event.get("id", ""))
                if call_id in tool_blocks:
                    argument_buffers[call_id] += str(event.get("arguments", ""))
            elif event_type == "done":
                # 单轮结束：记录 usage、停止原因与可能的错误信息
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
                # 把流式拼接的工具参数 JSON 解析为字典
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
        """带自动重试的 Provider 轮次：临时故障按 RetryPolicy 指数退避重试，
        额度类错误或超过最大次数后原样返回失败消息。"""
        attempt = 0
        while True:
            assistant, tool_calls = await self._provider_turn(new_messages)
            if assistant.get("stopReason") != "error":
                if attempt:
                    # 重试成功：通知 UI 结束重试状态
                    await self._emit("auto_retry_end", success=True, attempt=attempt)
                self.retry_attempt = 0
                return assistant, tool_calls

            policy = self.retry_policy
            # 未启用重试 / 超过次数 / 不属于可重试错误：直接返回失败
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
            # 说明：失败消息保留在只追加的 Session 里，但从重试用的上下文弹出，
            # 避免把错误信息再次喂给模型。
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
        """返回上下文占用统计（token 数、窗口大小、占用百分比）；未配置窗口时返回 None。"""
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
        """把增量追加到最后一个同类型 block；否则新建一个 block。"""
        if content and content[-1].get("type") == block_type:
            content[-1][field] += delta
        else:
            content.append({"type": block_type, field: delta})

    async def _execute_tools(
        self,
        tool_calls: list[dict[str, Any]],
        new_messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """执行工具调用：默认并行；只要有一个工具声明 sequential 就整体串行。"""
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
        """串行执行：逐个发出开始事件、执行并立即写回结果消息。"""
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
        # 说明：与 pi 行为一致——开始事件按调用顺序发，执行并发，
        # 结束事件按完成顺序，结果消息保持调用顺序写回。
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
        """运行单个工具调用：成功返回结构化结果，异常归一化为 isError 的 toolResult；
        配置了审批钩子且用户拒绝时，不执行并同样归一化为 isError。"""
        call_id = call["id"]
        name = call["name"]
        arguments = call["arguments"]
        if self.tool_approver is not None:
            try:
                approved = await self.tool_approver(call_id, name, arguments)
            except asyncio.CancelledError:
                raise
            if not approved:
                # 用户拒绝：不执行，返回 isError 的 toolResult 交给模型继续推理
                await self._emit(
                    "tool_execution_blocked",
                    toolCallId=call_id,
                    toolName=name,
                    args=deepcopy(arguments),
                )
                return self._tool_message(
                    call_id,
                    name,
                    [{"type": "text", "text": "Tool call was blocked by the user"}],
                    is_error=True,
                )
        try:
            result = await self.tools.execute(call_id, name, arguments)
        except asyncio.CancelledError:
            raise
        except Exception as exception:
            content = [{"type": "text", "text": str(exception)}]
            details = None
            is_error = True
        else:
            content = deepcopy(result.content)
            details = deepcopy(result.details)
            is_error = result.is_error
        tool_message = self._tool_message(call_id, name, content, is_error=is_error)
        await self._emit(
            "tool_execution_end",
            toolCallId=call_id,
            toolName=name,
            result={"content": content, "details": details},
            isError=is_error,
        )
        return tool_message

    @staticmethod
    def _tool_message(
        call_id: str,
        name: str,
        content: list[dict[str, Any]],
        *,
        is_error: bool,
    ) -> dict[str, Any]:
        """构造工具结果消息（统一 role/toolCallId/toolName/isError 结构）。"""
        return {
            "role": "toolResult",
            "toolCallId": call_id,
            "toolName": name,
            "content": content,
            "isError": is_error,
            "timestamp": _timestamp_ms(),
        }

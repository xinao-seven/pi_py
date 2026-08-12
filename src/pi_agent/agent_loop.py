"""Provider-neutral streaming Agent loop.

This module depends only on pi_ai primitives and pi_agent abstractions. A
structural transcript store may be supplied by an application layer, but the
agent package does not import any coding-agent implementation.

中文说明：通用 Agent 主循环，把 Provider 流式响应、工具执行、消息持久化
和 UI 事件串成一轮完整对话。

整体流程（prompt 入口）：

    用户消息
      │  _append_message（写入 Session + 运行时消息列表 + 发布事件）
      ▼
    ┌─────────────────────────────────────────────────────────┐
    │ while 未中止：                                            │
    │   1. _provider_turn_with_retry                           │
    │      → 流式读取 Provider 事件，组装 assistant 消息        │
    │      → 收集工具调用（流式 JSON 参数先累积后解析）          │
    │      → 出错时按 RetryPolicy 指数退避重试                  │
    │   2. _execute_tools（并行/串行）                          │
    │      → 每个工具调用：审批钩子 → 执行 → 归一化 toolResult   │
    │   3. 决策下一步：                                        │
    │      - 有 steer（运行中插入）→ 追加并继续本轮              │
    │      - 有工具调用 → 工具结果已写回，继续推理              │
    │      - 有 follow-up（排队）→ 消费一条继续运行             │
    │      - 都没有 → 正常结束                                  │
    └─────────────────────────────────────────────────────────┘

为保持通用性，持久化只依赖 TranscriptStore 协议（四个方法），
本包不导入任何编程助手的具体实现；工具审批也只依赖 ToolApprover
协议，危险命令的具体规则由应用层注入。
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

# 事件监听器：接收 AgentEvent，可以同步返回 None 或返回 Awaitable（异步监听器）
EventListener = Callable[[AgentEvent], None | Awaitable[None]]


class ToolApprover(Protocol):
    """工具执行前的审批钩子：返回 True 放行，False 拒绝。

    中文说明：由应用层注入（如危险命令人工确认）。pi_agent 层只负责
    在工具执行前调用并信任返回值，不知道“危险命令”的具体规则。
    调用参数包含 tool_call_id，便于应用层把挂起的确认请求与
    后续的人工响应（允许/拒绝）关联起来。
    """

    def __call__(
        self,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> Awaitable[bool]: ...


class TranscriptStore(Protocol):
    """转录存储协议：AgentRuntime 只依赖这四个方法，不关心底层是文件还是数据库。

    中文说明：这样设计让 pi_agent 层可以脱离具体持久化实现单独测试；
    上层（pi_coding_agent 的 SessionManager）实现该协议即可接入。
    """

    def build_session_context(self) -> dict[str, Any]:
        """返回历史上下文（含 messages 等），用于恢复运行时状态。"""
        ...

    def append_message(self, message: dict[str, Any]) -> str:
        """把一条消息追加进只增（append-only）的转录，返回 entry_id。"""
        ...

    def append_model_change(self, provider: str, model_id: str) -> str:
        """记录一次模型切换（会话历史里留痕）。"""
        ...

    def append_thinking_level_change(self, thinking_level: str) -> str:
        """记录一次思考档位切换。"""
        ...


def _timestamp_ms() -> int:
    """生成消息时间戳（UTC 毫秒，与 pi Session 的时间戳格式一致）。"""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class AgentRuntime:
    """Run prompts, provider turns, and tool calls while emitting UI events.

    中文说明：核心运行时。维护消息列表、工具注册表、Provider 与思考档位，
    对外提供 prompt / steer / follow-up / abort / set_model 等操作，
    并持续向订阅者发布 AgentEvent（消息增量、工具执行、回合结束等）。

    关键状态字段：

    - messages         当前上下文消息（含运行中新增的），每次 Provider 请求都会带上
    - _steering        运行中插入的消息（立即参与当前回合）
    - _follow_ups      运行中排队的消息（当前回合自然结束后处理）
    - _run_task        当前运行的 asyncio 任务，abort 用它取消
    - _abort_requested 中止标记：主循环与流式读取都会检查它
    - is_streaming     是否正在运行（steer/follow-up 的守卫条件）
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
        # Provider 与模型：所有请求都基于这两个字段；set_model 可原子更换
        self.provider = provider
        self.model = model
        # 转录存储：None 表示纯内存模式（不持久化，供无 Session 的测试使用）
        self.session = session
        # 工具注册表：持有工具定义（喂给模型）与执行入口
        self.tools = tools
        # 系统提示：拼在每次 Provider 请求的最前面（编程助手会注入工具清单/项目指令）
        self.system_prompt = system_prompt
        # 思考档位：off/minimal/low/medium/high/xhigh/max，传给 Provider 映射
        self.thinking_level = thinking_level
        # 工具执行策略：parallel（默认，并发执行）或 sequential（整体串行）
        self.tool_execution = tool_execution
        # 自动重试策略：None 表示不重试
        self.retry_policy = retry_policy
        # 上下文窗口（token）：<=0 表示未配置，get_context_usage 返回 None
        self.context_window = context_window
        # 工具审批钩子：None 表示直接执行（默认行为）
        self.tool_approver = tool_approver
        # 从 Session 恢复的历史上下文；无 Session 时从空列表开始
        # （恢复后，新对话会在既有历史上继续，而不是从零开始）
        self.messages: list[dict[str, Any]] = (
            session.build_session_context()["messages"] if session is not None else []
        )
        # 事件监听器列表（SSE 桥接层通过 subscribe 挂进来）
        self._listeners: list[EventListener] = []
        # 运行中的插入消息（steer）与排队消息（follow-up）
        # 两者区别：steer 立即参与当前回合；follow-up 等当前回合结束后再处理
        self._steering: list[dict[str, Any]] = []
        self._follow_ups: list[dict[str, Any]] = []
        # 当前运行任务：abort 时对它 cancel；同时运行期间禁止再次 prompt
        self._run_task: asyncio.Task[None] | None = None
        # 中止标记：置位后主循环停止拉取新回合，流式读取也提前退出
        self._abort_requested = False
        self.is_streaming = False
        self.is_retrying = False
        self.retry_attempt = 0

    def subscribe(self, listener: EventListener) -> Callable[[], None]:
        """注册事件监听器，返回取消订阅函数。

        中文说明：监听器收到所有 AgentEvent（agent_start/end、message_*、
        tool_execution_*、turn_*、auto_retry_* 等）。取消订阅函数是幂等的。
        """
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    async def _emit(self, event_type: str, **payload: Any) -> None:
        """广播一个 AgentEvent：包装成事件对象后逐个通知监听器。

        中文说明：listener 既可以是同步函数也可以是协程（inspect.isawaitable
        判断）；逐个 await 保证事件按发布顺序到达，避免并发乱序。
        """
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
        """切换模型；可同时更换 Provider 与上下文窗口，并写入 Session 记录。

        中文说明：不传 provider 时只换模型 id（同一 Provider 内的模型切换）；
        context_window 更新后，自动压缩的阈值判断会立即生效。
        """
        if provider is not None:
            self.provider = provider
        self.model = model
        if context_window is not None:
            self.context_window = max(0, context_window)
        if self.session is not None:
            self.session.append_model_change(self.provider.name, model)

    def set_thinking_level(self, level: str) -> None:
        """切换思考档位并写入 Session 记录（下次 Provider 请求生效）。"""
        self.thinking_level = level
        if self.session is not None:
            self.session.append_thinking_level_change(level)

    def set_active_tools(self, names: list[str]) -> None:
        """切换本轮可被模型调用的工具集合。

        中文说明：通过 ToolRegistry 的启停机制实现；被停用的工具不会出现在
        下一次 Provider 请求的 tools 定义里，模型自然无法调用。
        """
        self.tools.set_active(names)

    async def steer(self, content: str | list[dict[str, Any]]) -> None:
        """运行中插入一条消息，立即参与当前回合（只有运行时才能调用）。

        中文说明：对应 Web 端的“插入指令”——比如模型正在执行任务时，
        用户插入“先不要动测试文件”。插入消息会被主循环优先处理，在当前
        回合继续推理，而不是等到回合结束。
        """
        if not self.is_streaming:
            raise RuntimeError("Cannot steer while the Agent is idle")
        self._steering.append(self._user_message(content))

    async def follow_up(self, content: str | list[dict[str, Any]]) -> None:
        """运行中排队一条消息，在当前回合自然结束后处理。

        中文说明：与 steer 不同，follow-up 不会打断当前回合；主循环在
        没有工具调用、没有 steer 时才消费它（一次一条）。
        """
        if not self.is_streaming:
            raise RuntimeError("Cannot queue a follow-up while the Agent is idle")
        self._follow_ups.append(self._user_message(content))

    async def abort(self) -> None:
        """请求中止：置位标记并取消当前运行任务。

        中文说明：置位 _abort_requested 后，流式读取循环会在下一个事件处
        抛 CancelledError 提前退出；同时 cancel 运行任务作为兜底。
        中止后的清理逻辑（agent_end 事件、is_streaming 复位）在
        prompt 的 finally 块中统一完成。
        """
        self._abort_requested = True
        task = self._run_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    async def prompt(self, content: str | list[dict[str, Any]]) -> None:
        """主入口：发起一次新的对话运行。

        追加用户消息后进入循环：

        1. 调 Provider 得到助手回复与工具调用（带自动重试）；
        2. 执行工具并把结果写回上下文；
        3. 决策下一步：
           - 有 steer → 插入当前回合继续；
           - 有工具调用 → 工具结果已写回，交给模型继续推理；
           - 有 follow-up → 消费一条继续运行；
           - 都没有 → 正常结束。

        无论正常结束、异常还是被取消，finally 都会广播 agent_end 事件并
        复位运行状态，保证 UI 侧一定能收到终态。
        """
        if self.is_streaming:
            raise RuntimeError("Agent is already running")
        # 校验并规范化用户输入（文本去空白 / 内容块校验）
        normalized_content = self._normalize_user_content(content)
        self.is_streaming = True
        self._abort_requested = False
        # 记录当前任务，abort 需要引用它；注意必须用 current_task() 而非 create_task
        self._run_task = asyncio.current_task()
        # new_messages：本轮新增的消息（Session 里是只增的，用新增列表区分）
        new_messages: list[dict[str, Any]] = []
        error: str | None = None
        await self._emit("agent_start")
        try:
            # 第一步：把用户消息写入 Session + 运行时上下文，并发布事件
            user_message = self._user_message(normalized_content)
            await self._append_message(user_message, new_messages)
            # 主循环：每次迭代完成“模型推理一轮 + 执行工具一轮”
            while not self._abort_requested:
                # 1) 模型推理（含自动重试），得到 assistant 消息与工具调用列表
                assistant, tool_calls = await self._provider_turn_with_retry(new_messages)
                if assistant.get("stopReason") == "error":
                    # Provider 出错（且不可重试）时记录错误并结束本轮
                    error = str(assistant.get("errorMessage") or "Provider error")
                    break
                # 2) 执行模型请求的工具，结果写回上下文（toolResult 消息）
                tool_results = await self._execute_tools(tool_calls, new_messages)
                # 3) 广播回合结束：包含助手消息、工具结果与当前上下文占用
                await self._emit(
                    "turn_end",
                    message=deepcopy(assistant),
                    toolResults=deepcopy(tool_results),
                    contextUsage=self.get_context_usage(),
                )
                # 4) 决策下一步：steer 优先（立即参与当前回合）
                steering = self._drain(self._steering)
                if steering:
                    # 有 steer：把插入消息追加进当前回合，继续推理
                    for message in steering:
                        await self._append_message(message, new_messages)
                    continue
                if tool_calls:
                    # 模型请求了工具：工具结果已作为消息写回，交给模型继续推理
                    # （continue 回到 while 顶部，再次调用 Provider）
                    continue
                # 没有工具调用时才消费下一条 follow-up（一次一条），并继续运行
                follow_ups = self._drain(self._follow_ups, one=True)
                if follow_ups:
                    await self._append_message(follow_ups[0], new_messages)
                    continue
                # 没有 steer / 工具调用 / follow-up：正常结束运行
                break
        except asyncio.CancelledError:
            # 被 abort 取消：置位标记，agent_end 会带上 aborted=true
            self._abort_requested = True
        except Exception as exception:
            # 未预期异常：记录错误后向上抛出（由调用方决定如何处理）
            error = str(exception)
            raise
        finally:
            # 无论哪种退出路径，都广播终态事件并复位运行状态
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
        """构造一条用户消息（role=user + 时间戳），内容做深拷贝防止外部篡改。"""
        return {"role": "user", "content": deepcopy(content), "timestamp": _timestamp_ms()}

    @staticmethod
    def _normalize_user_content(content: str | list[dict[str, Any]]) -> str | list[dict[str, Any]]:
        """校验并规范化用户输入：

        - 纯文本：去掉首尾空白，不能为空；
        - 内容块列表：只保留 dict 块，且必须包含至少一个有效文本块或图片块。
        非法输入抛 ValueError，由上层转成用户可见的错误。
        """
        if isinstance(content, str):
            normalized = content.strip()
            if not normalized:
                raise ValueError("Prompt must not be empty")
            return normalized
        if not isinstance(content, list):
            raise ValueError("Prompt content must be text or content blocks")
        blocks = [deepcopy(block) for block in content if isinstance(block, dict)]
        # 至少包含一个“有实际内容”的文本块或图片块才算合法
        if not blocks or not any(
            (block.get("type") == "text" and str(block.get("text", "")).strip())
            or (block.get("type") == "image" and block.get("data") and block.get("mimeType"))
            for block in blocks
        ):
            raise ValueError("Prompt must contain text or an image")
        return blocks

    @staticmethod
    def _drain(queue: list[dict[str, Any]], *, one: bool = False) -> list[dict[str, Any]]:
        """从队列头部取出消息并清空已取部分。

        中文说明：one=True 时最多取一条（follow-up 一次只消费一条）；
        否则取空整队（steer 可以多条一起插入）。
        """
        count = min(1, len(queue)) if one else len(queue)
        drained = queue[:count]
        del queue[:count]
        return drained

    async def _append_message(
        self,
        message: dict[str, Any],
        new_messages: list[dict[str, Any]],
    ) -> str:
        """把消息同时写入 Session（持久化）与运行时消息列表，并发布事件。

        中文说明：这是“双写”的核心点——
        - self.messages：每次 Provider 请求都会带上（当前上下文）；
        - new_messages：本轮新增列表（agent_end 事件里汇报给 UI）；
        - Session：只增转录，重启后可恢复。
        发布 message_start/message_end 两个事件，UI 据此渲染消息。
        """
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
        收集工具调用（流式 JSON 参数在流结束后统一解析），并持久化 assistant 消息。

        返回 (assistant, tool_calls)：assistant 是要写回上下文的消息，
        tool_calls 是本轮模型请求的工具调用列表（可能为空）。

        流式事件说明（归一化协议，见 pi_ai.providers.base）：

        - text_delta / thinking_delta  文本/思考增量，累积进 content 块
        - tool_call_start              新工具调用开始（带 id/name）
        - tool_call_delta              工具参数的 JSON 字符串片段（按 id 累积）
        - done                         本轮结束：携带 usage / stop_reason / error

        每个事件都会作为 message_update 转发给 UI，实现逐字流式渲染。
        """
        await self._emit("turn_start")
        # assistant 消息骨架：content 初始为空，随流式事件逐步填充
        assistant: dict[str, Any] = {
            "role": "assistant",
            "content": [],
            "provider": self.provider.name,
            "model": self.model,
            "timestamp": _timestamp_ms(),
        }
        await self._emit("message_start", message=deepcopy(assistant))
        # tool_blocks：按 call_id 索引的工具调用块（最终会进 assistant.content）
        tool_blocks: dict[str, dict[str, Any]] = {}
        # argument_buffers：按 call_id 累积的工具参数 JSON 字符串片段
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
                # 中止请求：立即结束本轮流式读取（抛 CancelledError）
                raise asyncio.CancelledError
            event_type = event.get("type")
            if event_type == "text_delta":
                # 文本增量：追加到最后一个 text 块（或新建），实现逐字流式
                self._append_delta(assistant["content"], "text", "text", str(event.get("text", "")))
            elif event_type == "thinking_delta":
                # 思考增量：同上，但块类型是 thinking（UI 折叠展示）
                self._append_delta(
                    assistant["content"], "thinking", "thinking", str(event.get("text", ""))
                )
            elif event_type == "tool_call_start":
                # 新工具调用：创建块并登记到 tool_blocks / argument_buffers
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
                # 工具参数片段：按 id 追加进缓冲区（流式 JSON，最后统一解析）
                call_id = str(event.get("id", ""))
                if call_id in tool_blocks:
                    argument_buffers[call_id] += str(event.get("arguments", ""))
            elif event_type == "done":
                # 单轮结束：记录 usage、停止原因与可能的错误信息
                usage = deepcopy(event.get("usage")) if isinstance(event.get("usage"), dict) else None
                stop_reason = str(event.get("stop_reason", "stop"))
                error_message = str(event["error"]) if event.get("error") else None
            # 每个原始事件都转发给 UI（message_update），驱动前端流式渲染
            await self._emit(
                "message_update",
                message=deepcopy(assistant),
                assistantMessageEvent=deepcopy(event),
            )
        # 流结束后：把每个工具调用的参数 JSON 片段解析成真正的 dict
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
        # 填充 assistant 消息的停止原因 / usage / 错误信息
        assistant["stopReason"] = "error" if error_message else stop_reason
        if usage is not None:
            assistant["usage"] = usage
        if error_message:
            assistant["errorMessage"] = error_message
        # 持久化 assistant 消息并追加进运行时上下文（与用户消息同路径）
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
        额度类错误或超过最大次数后原样返回失败消息。

        判定“是否可重试”委托给 pi_ai.utils.is_retryable_assistant_error
        （区分网络/5xx 等临时错误与 429/额度等不可重试错误）。

        重试期间会把失败消息从“运行时上下文”弹出，但保留在只增的
        Session 里——避免把错误文本再次喂给模型，同时不破坏历史完整性。
        """
        attempt = 0
        while True:
            # 先执行一轮完整推理
            assistant, tool_calls = await self._provider_turn(new_messages)
            if assistant.get("stopReason") != "error":
                # 成功（或不可重试的错误之外的一切正常路径）：若之前重试过，通知 UI 恢复
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

            # 决定重试：attempt+1，按策略计算退避延迟
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
                # 退避等待期间被取消（如用户 abort）：通知 UI 后向上传播
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
        """返回上下文占用统计（token 数、窗口大小、占用百分比）；未配置窗口时返回 None。

        中文说明：前端用它渲染上下文占用条；上层（AgentSession）在压缩
        判断时也会调用它。估算包含系统提示与工具定义，不只看消息文本。
        """
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
        """把增量追加到最后一个同类型 block；否则新建一个 block。

        中文说明：流式文本的常见技巧——连续的同类型片段合并成一个块，
        减少消息体积；遇到不同类型（如 thinking → text）时新建块。
        """
        if content and content[-1].get("type") == block_type:
            content[-1][field] += delta
        else:
            content.append({"type": block_type, field: delta})

    async def _execute_tools(
        self,
        tool_calls: list[dict[str, Any]],
        new_messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """执行工具调用：默认并行；只要有一个工具声明 sequential 就整体串行。

        中文说明：执行策略由实例级 tool_execution 与单工具的
        execution_mode（可覆盖）共同决定。串行/并行只影响执行顺序，
        结果消息都按调用顺序写回上下文，保证会话一致性。
        """
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
        """串行执行：逐个发出开始事件、执行并立即写回结果消息。

        中文说明：适合依赖前置结果的工具（如“先编辑再读取”）；每个工具
        的结果消息立即持久化，中途失败不影响前面已完成的部分。
        """
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
        # 这样 UI 端先看到“逐个开始”，再按完成先后看到结果；而写入会话的
        # 顺序稳定为调用顺序，便于回放与压缩裁剪。
        for call in tool_calls:
            await self._emit_tool_start(call)
        # gather 并发执行全部工具；任一个抛异常都会向上传播（由外层兜底）
        results = list(await asyncio.gather(*(self._run_tool(call) for call in tool_calls)))
        for tool_message in results:
            await self._append_message(tool_message, new_messages)
        return results

    async def _emit_tool_start(self, call: dict[str, Any]) -> None:
        """广播工具开始事件（UI 据此展示“正在执行”状态）。"""
        await self._emit(
            "tool_execution_start",
            toolCallId=call["id"],
            toolName=call["name"],
            args=deepcopy(call["arguments"]),
        )

    async def _run_tool(self, call: dict[str, Any]) -> dict[str, Any]:
        """运行单个工具调用：成功返回结构化结果，异常归一化为 isError 的 toolResult；
        配置了审批钩子且用户拒绝时，不执行并同样归一化为 isError。

        中文说明：无论工具成功、抛异常还是被审批拒绝，最终都会产出
        role=toolResult 的消息写回上下文——模型只会看到统一的工具结果结构，
        不需要区分失败原因。审批拒绝的结果同样会告诉模型“该命令未执行”。
        """
        call_id = call["id"]
        name = call["name"]
        arguments = call["arguments"]
        # 执行前先过审批钩子（危险命令人工确认等应用层策略）
        if self.tool_approver is not None:
            try:
                approved = await self.tool_approver(call_id, name, arguments)
            except asyncio.CancelledError:
                # 审批等待期间被取消（如用户 abort）：向上传播，不产生结果消息
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
            # 取消必须原样传播，不能被当作普通异常吞掉
            raise
        except Exception as exception:
            # 工具实现抛出的任何异常都归一化为 isError 的结果（内容为错误文本）
            content = [{"type": "text", "text": str(exception)}]
            details = None
            is_error = True
        else:
            # 正常返回：拷贝结果内容与详情（防止工具内部复用可变对象）
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
        """构造工具结果消息（统一 role/toolCallId/toolName/isError 结构）。

        中文说明：toolCallId 与模型发起的工具调用一一对应，模型靠它把
        结果关联回自己的调用；isError 告诉模型本次调用是否失败。
        """
        return {
            "role": "toolResult",
            "toolCallId": call_id,
            "toolName": name,
            "content": content,
            "isError": is_error,
            "timestamp": _timestamp_ms(),
        }

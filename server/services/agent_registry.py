"""Active AgentSession registry with bounded event replay.

中文说明：活跃 Agent 注册表：管理运行中的 AgentSession 生命周期
（创建/激活/空闲回收/关闭），并为每个 Agent 维护有界事件回放与多订阅者 SSE。
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
import os
from pathlib import Path
from typing import Any, Protocol

from pi_agent import ToolRegistry
from pi_ai.providers.base import LLMProvider
from pi_ai.providers.registry import create_provider
from pi_coding_agent import (
    AgentSession,
    CodingResourceLoader,
    CompactionSettings,
    SessionManager,
    create_builtin_tools,
)
from server.services.session_store import SessionStore


class ProviderResolver(Protocol):
    # 按名称解析 Provider 实例的协议（测试可注入）
    def __call__(self, name: str) -> LLMProvider: ...


@dataclass(frozen=True, slots=True)
class ResolvedModel:
    provider: str
    model: str
    context_window: int = 0


class ModelResolver(Protocol):
    # 按 provider/model 解析模型元数据（含上下文窗口）的协议
    def __call__(self, provider: str, model: str) -> ResolvedModel: ...


class ProviderConfigurationError(ValueError):
    """Provider 未配置或密钥缺失时抛出的错误。"""
    pass


def environment_provider_resolver(name: str) -> LLMProvider:
    """默认 Provider 解析器：从环境变量 {NAME}_API_KEY / {NAME}_BASE_URL 构造。"""
    normalized = "openai" if name == "openai-compatible" else name
    prefix = normalized.upper().replace("-", "_")
    api_key = os.getenv(f"{prefix}_API_KEY")
    if not api_key:
        raise ProviderConfigurationError(f"Environment variable {prefix}_API_KEY is not set")
    return create_provider(
        name,
        api_key=api_key,
        base_url=os.getenv(f"{prefix}_BASE_URL"),
    )


def _camelize_key(value: str) -> str:
    """把 snake_case 键转成 camelCase（如 context_window -> contextWindow）。"""
    head, *tail = value.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def web_value(value: Any) -> Any:
    """递归把事件里的 snake_case 键转 camelCase，供 Web 端直接使用。"""
    if isinstance(value, dict):
        return {_camelize_key(str(key)): web_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [web_value(item) for item in value]
    if isinstance(value, tuple):
        return [web_value(item) for item in value]
    return value


@dataclass(slots=True, eq=False)
class RegistryEntry:
    """一个活跃 Agent 的注册项：持有 AgentSession、事件回放队列、
    订阅者队列、空闲定时器与运行任务集合。"""
    agent: AgentSession
    idle_timeout: float
    on_idle: Callable[[str], None]
    provider_resolver: ProviderResolver
    model_resolver: ModelResolver
    replay_limit: int = 256
    _events: deque[tuple[int, dict[str, Any]]] = field(init=False)
    _subscribers: set[asyncio.Queue[tuple[int, dict[str, Any]]]] = field(default_factory=set)
    _tasks: set[asyncio.Task[Any]] = field(default_factory=set)
    _idle_task: asyncio.Task[None] | None = None
    _unsubscribe_agent: Callable[[], None] | None = None
    _sequence: int = 0
    alive: bool = True

    def __post_init__(self) -> None:
        self._events = deque(maxlen=self.replay_limit)
        # 订阅 Agent 内部事件，统一转成带序号的事件流
        self._unsubscribe_agent = self.agent.subscribe(self._publish_agent_event)
        self.touch()

    @property
    def session_id(self) -> str:
        return self.agent.session_manager.session_id

    def _publish_agent_event(self, event) -> None:
        self.publish(event.to_dict())

    def set_model(self, provider_name: str, model: str) -> ResolvedModel:
        """切换模型：解析配置 -> 构造 Provider -> 更新 Agent。"""
        resolved = self.model_resolver(provider_name, model)
        provider = self.provider_resolver(resolved.provider)
        self.agent.set_model(
            resolved.model,
            provider=provider,
            context_window=resolved.context_window,
        )
        return resolved

    def publish(self, event: dict[str, Any]) -> int:
        """发布一个事件：写入回放缓冲并广播给所有订阅队列。"""
        self._sequence += 1
        item = (self._sequence, web_value(event))
        self._events.append(item)
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(item)
        return self._sequence

    def subscribe(
        self,
        *,
        after_event_id: int = 0,
    ) -> tuple[asyncio.Queue[tuple[int, dict[str, Any]]], Callable[[], None]]:
        """新增订阅者：先回放 after_event_id 之后的历史事件，返回队列与退订函数。"""
        queue: asyncio.Queue[tuple[int, dict[str, Any]]] = asyncio.Queue(
            maxsize=self.replay_limit
        )
        for item in self._events:
            if item[0] > after_event_id:
                queue.put_nowait(item)
        self._subscribers.add(queue)

        def unsubscribe() -> None:
            self._subscribers.discard(queue)

        return queue, unsubscribe

    def start(self, awaitable: Awaitable[Any]) -> asyncio.Task[Any]:
        """启动一个 Agent 运行任务并纳入跟踪；完成后刷新空闲定时器。"""
        task = asyncio.create_task(awaitable)
        self._tasks.add(task)
        self._cancel_idle_timer()

        def completed(finished: asyncio.Task[Any]) -> None:
            self._tasks.discard(finished)
            try:
                finished.result()
            except (asyncio.CancelledError, Exception):
                pass
            if self.alive:
                self.touch()

        task.add_done_callback(completed)
        return task

    def touch(self) -> None:
        """刷新空闲定时器（每次有活动就重新计时）。"""
        self._cancel_idle_timer()
        if self.idle_timeout <= 0 or not self.alive:
            return
        self._idle_task = asyncio.create_task(self._idle_cleanup())

    async def _idle_cleanup(self) -> None:
        """空闲超时后调用 on_idle 回收该 Agent。"""
        try:
            await asyncio.sleep(self.idle_timeout)
            self.on_idle(self.session_id)
        except asyncio.CancelledError:
            pass

    def _cancel_idle_timer(self) -> None:
        if self._idle_task is not None and not self._idle_task.done():
            self._idle_task.cancel()
        self._idle_task = None

    async def close(self) -> None:
        """关闭注册项：退订、中止 Agent、取消全部任务并清空订阅者。"""
        if not self.alive:
            return
        self.alive = False
        self._cancel_idle_timer()
        if self._unsubscribe_agent is not None:
            self._unsubscribe_agent()
            self._unsubscribe_agent = None
        await self.agent.abort()
        tasks = list(self._tasks)
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._subscribers.clear()


class AgentRegistry:
    """会话 -> RegistryEntry 的映射，负责 Agent 的创建、激活与回收。"""
    def __init__(
        self,
        store: SessionStore,
        *,
        provider_resolver: ProviderResolver = environment_provider_resolver,
        model_resolver: ModelResolver | None = None,
        agent_dir: str | Path | None = None,
        idle_timeout: float = 600,
    ) -> None:
        # provider_resolver/model_resolver 可注入，测试用 FakeProvider 替换
        self.store = store
        self.provider_resolver = provider_resolver
        self.model_resolver = model_resolver or (
            lambda provider, model: ResolvedModel(provider, model)
        )
        self.agent_dir = Path(agent_dir).expanduser().resolve() if agent_dir is not None else None
        self.idle_timeout = idle_timeout
        self._entries: dict[str, RegistryEntry] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def get(self, session_id: str) -> RegistryEntry | None:
        entry = self._entries.get(session_id)
        return entry if entry is not None and entry.alive else None

    def workspace_roots(self) -> tuple[Path, ...]:
        """返回所有活跃 Agent 的工作目录（供文件/技能服务校验）。"""
        return tuple(entry.agent.session_manager.cwd for entry in self._entries.values() if entry.alive)

    def entries(self) -> tuple[RegistryEntry, ...]:
        return tuple(entry for entry in self._entries.values() if entry.alive)

    async def create(
        self,
        *,
        cwd: str | Path,
        provider_name: str,
        model: str,
        thinking_level: str = "off",
        tool_names: list[str] | None = None,
    ) -> RegistryEntry:
        """新建持久化 Session 并注册 Agent。"""
        workspace = Path(cwd).expanduser().resolve()
        manager = SessionManager.create(
            workspace,
            self.store.session_directory(workspace),
        )
        return self._register(
            manager,
            provider_name=provider_name,
            model=model,
            thinking_level=thinking_level,
            tool_names=tool_names,
        )

    async def activate(
        self,
        session_id: str,
        *,
        provider_name: str,
        model: str,
        tool_names: list[str] | None = None,
    ) -> RegistryEntry | None:
        """按 session_id 激活历史会话：优先恢复 Session 里保存的模型设置。"""
        existing = self.get(session_id)
        if existing is not None:
            existing.touch()
            return existing
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        try:
            async with lock:
                existing = self.get(session_id)
                if existing is not None:
                    return existing
                manager = self.store.open(session_id)
                if manager is None:
                    return None
                context = manager.build_session_context()
                saved_model = context.get("model")
                if isinstance(saved_model, dict):
                    # 恢复历史会话时沿用其保存的 provider/model
                    saved_provider = saved_model.get("provider")
                    saved_model_id = saved_model.get("modelId")
                    if isinstance(saved_provider, str) and isinstance(saved_model_id, str):
                        provider_name = saved_provider
                        model = saved_model_id
                return self._register(
                    manager,
                    provider_name=provider_name,
                    model=model,
                    thinking_level=str(context.get("thinkingLevel") or "off"),
                    tool_names=tool_names,
                )
        finally:
            self._locks.pop(session_id, None)

    def _register(
        self,
        manager: SessionManager,
        *,
        provider_name: str,
        model: str,
        thinking_level: str,
        tool_names: list[str] | None,
    ) -> RegistryEntry:
        """核心装配：解析模型/Provider，构造工具与 AgentSession，创建注册项。"""
        resolved_model = self.model_resolver(provider_name, model)
        provider = self.provider_resolver(resolved_model.provider)
        context = manager.build_session_context()
        branch = manager.get_branch()
        # 首次创建的会话：把初始模型与思考档位持久化到 Session
        if context.get("model") is None:
            manager.append_model_change(resolved_model.provider, resolved_model.model)
        if not any(entry.get("type") == "thinking_level_change" for entry in branch):
            manager.append_thinking_level_change(thinking_level)
        tools = ToolRegistry(create_builtin_tools(manager.cwd))
        if tool_names is not None:
            tools.set_active(tool_names)
        agent = AgentSession(
            provider=provider,
            model=resolved_model.model,
            session_manager=manager,
            tool_registry=tools,
            thinking_level=thinking_level,
            context_window=resolved_model.context_window,
            compaction_settings=CompactionSettings(),
            resource_loader=CodingResourceLoader(manager.cwd, agent_dir=self.agent_dir),
        )
        entry = RegistryEntry(
            agent=agent,
            idle_timeout=self.idle_timeout,
            on_idle=self.remove_later,
            provider_resolver=self.provider_resolver,
            model_resolver=self.model_resolver,
        )
        self._entries[manager.session_id] = entry
        return entry

    def remove_later(self, session_id: str) -> None:
        """空闲回收：异步关闭注册项。"""
        entry = self._entries.pop(session_id, None)
        if entry is not None:
            asyncio.create_task(entry.close())

    async def remove(self, session_id: str) -> None:
        """显式移除（如删除会话时）：同步关闭。"""
        entry = self._entries.pop(session_id, None)
        if entry is not None:
            await entry.close()

    async def close(self) -> None:
        """应用关闭时清理所有注册项。"""
        entries = list(self._entries.values())
        self._entries.clear()
        await asyncio.gather(*(entry.close() for entry in entries), return_exceptions=True)

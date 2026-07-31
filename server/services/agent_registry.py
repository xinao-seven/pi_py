"""Active AgentSession registry with bounded event replay."""

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
    def __call__(self, name: str) -> LLMProvider: ...


@dataclass(frozen=True, slots=True)
class ResolvedModel:
    provider: str
    model: str
    context_window: int = 0


class ModelResolver(Protocol):
    def __call__(self, provider: str, model: str) -> ResolvedModel: ...


class ProviderConfigurationError(ValueError):
    pass


def environment_provider_resolver(name: str) -> LLMProvider:
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
    head, *tail = value.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def web_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {_camelize_key(str(key)): web_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [web_value(item) for item in value]
    if isinstance(value, tuple):
        return [web_value(item) for item in value]
    return value


@dataclass(slots=True, eq=False)
class RegistryEntry:
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
        self._unsubscribe_agent = self.agent.subscribe(self._publish_agent_event)
        self.touch()

    @property
    def session_id(self) -> str:
        return self.agent.session_manager.session_id

    def _publish_agent_event(self, event) -> None:
        self.publish(event.to_dict())

    def set_model(self, provider_name: str, model: str) -> ResolvedModel:
        resolved = self.model_resolver(provider_name, model)
        provider = self.provider_resolver(resolved.provider)
        self.agent.set_model(
            resolved.model,
            provider=provider,
            context_window=resolved.context_window,
        )
        return resolved

    def publish(self, event: dict[str, Any]) -> int:
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
        self._cancel_idle_timer()
        if self.idle_timeout <= 0 or not self.alive:
            return
        self._idle_task = asyncio.create_task(self._idle_cleanup())

    async def _idle_cleanup(self) -> None:
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
    def __init__(
        self,
        store: SessionStore,
        *,
        provider_resolver: ProviderResolver = environment_provider_resolver,
        model_resolver: ModelResolver | None = None,
        agent_dir: str | Path | None = None,
        idle_timeout: float = 600,
    ) -> None:
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
        resolved_model = self.model_resolver(provider_name, model)
        provider = self.provider_resolver(resolved_model.provider)
        context = manager.build_session_context()
        branch = manager.get_branch()
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
        entry = self._entries.pop(session_id, None)
        if entry is not None:
            asyncio.create_task(entry.close())

    async def remove(self, session_id: str) -> None:
        entry = self._entries.pop(session_id, None)
        if entry is not None:
            await entry.close()

    async def close(self) -> None:
        entries = list(self._entries.values())
        self._entries.clear()
        await asyncio.gather(*(entry.close() for entry in entries), return_exceptions=True)

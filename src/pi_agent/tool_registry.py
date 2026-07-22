"""Runtime tool registration and activation."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from pi_agent.types import AgentTool, ToolError, ToolResult


class ToolRegistry:
    def __init__(self, tools: Iterable[AgentTool] = ()) -> None:
        self._tools: dict[str, AgentTool] = {}
        self._active: list[str] = []
        for tool in tools:
            self.register(tool)

    def register(self, tool: AgentTool, *, active: bool = True) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Tool already registered: {tool.name}")
        self._tools[tool.name] = tool
        if active:
            self._active.append(tool.name)

    def set_active(self, names: Iterable[str]) -> None:
        requested = list(dict.fromkeys(names))
        unknown = [name for name in requested if name not in self._tools]
        if unknown:
            raise KeyError(f"Unknown tools: {', '.join(unknown)}")
        self._active = requested

    def active_names(self) -> list[str]:
        return list(self._active)

    def definitions(self) -> list[dict[str, Any]]:
        return [self._tools[name].provider_definition() for name in self._active]

    async def execute(self, tool_call_id: str, name: str, arguments: Mapping[str, Any]) -> ToolResult:
        del tool_call_id
        if name not in self._active:
            raise ToolError(f"Tool is not active: {name}")
        if not isinstance(arguments, Mapping):
            raise ToolError("Tool arguments must be an object")
        return await self._tools[name].execute(arguments)

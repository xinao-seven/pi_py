"""General-purpose Agent types built on pi_ai primitives."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Mapping, TypeAlias

from pi_ai.types import Tool

JsonObject: TypeAlias = dict[str, Any]
ToolExecutor: TypeAlias = Callable[[Mapping[str, Any]], Awaitable["ToolResult"]]


class ToolError(Exception):
    """A user-visible tool validation or execution failure."""


@dataclass(frozen=True, slots=True)
class ToolResult:
    content: list[JsonObject]
    details: JsonObject | None = None
    is_error: bool = False

    @classmethod
    def text(
        cls,
        text: str,
        *,
        details: JsonObject | None = None,
        is_error: bool = False,
    ) -> ToolResult:
        return cls(content=[{"type": "text", "text": text}], details=details, is_error=is_error)


@dataclass(frozen=True, slots=True)
class AgentTool(Tool):
    label: str
    execute: ToolExecutor = field(repr=False, compare=False)
    execution_mode: Literal["sequential", "parallel"] | None = None


# Transitional source alias while coding-agent-specific display fields are added.
ToolDefinition = AgentTool

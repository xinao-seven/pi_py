"""Runtime tool registration and activation."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
import math
import re
from typing import Any, Literal

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

    def names(self) -> list[str]:
        return list(self._tools)

    def definitions(self) -> list[dict[str, Any]]:
        return [self._tools[name].provider_definition() for name in self._active]

    def execution_mode(self, name: str) -> Literal["sequential", "parallel"] | None:
        """Return a tool's scheduling constraint without exposing its executor."""

        tool = self._tools.get(name)
        if tool is None or name not in self._active:
            return None
        return tool.execution_mode

    async def execute(self, tool_call_id: str, name: str, arguments: Mapping[str, Any]) -> ToolResult:
        del tool_call_id
        if name not in self._active:
            raise ToolError(f"Tool is not active: {name}")
        if not isinstance(arguments, Mapping):
            raise ToolError("Tool arguments must be an object")
        tool = self._tools[name]
        _validate_schema(arguments, tool.input_schema, path="Tool arguments")
        return await tool.execute(arguments)


def _validate_schema(value: Any, schema: Mapping[str, Any], *, path: str) -> None:
    """Validate the JSON Schema subset used by Agent tool definitions."""

    if not isinstance(schema, Mapping):
        return
    if "enum" in schema and isinstance(schema["enum"], list) and value not in schema["enum"]:
        choices = ", ".join(repr(item) for item in schema["enum"])
        raise ToolError(f"{path} must be one of: {choices}")

    expected = schema.get("type")
    if isinstance(expected, list):
        if any(_matches_type(value, item) for item in expected if isinstance(item, str)):
            return
        names = ", ".join(str(item) for item in expected)
        raise ToolError(f"{path} must be one of these types: {names}")
    if isinstance(expected, str) and not _matches_type(value, expected):
        raise ToolError(f"{path} must be {_type_label(expected)}")

    if expected == "object" or isinstance(value, Mapping):
        if not isinstance(value, Mapping):
            return
        properties = schema.get("properties")
        property_schemas = properties if isinstance(properties, Mapping) else {}
        required = schema.get("required")
        if isinstance(required, list):
            for key in required:
                if isinstance(key, str) and key not in value:
                    raise ToolError(f"{path}.{key} is required")
        if schema.get("additionalProperties") is False:
            unexpected = [str(key) for key in value if key not in property_schemas]
            if unexpected:
                raise ToolError(f"{path} contains unexpected argument: {unexpected[0]}")
        for key, item in value.items():
            item_schema = property_schemas.get(key)
            if isinstance(item_schema, Mapping):
                _validate_schema(item, item_schema, path=f"{path}.{key}")

    if expected == "array" and isinstance(value, (list, tuple)):
        minimum = schema.get("minItems")
        maximum = schema.get("maxItems")
        if _is_integer(minimum) and len(value) < minimum:
            raise ToolError(f"{path} must contain at least {minimum} items")
        if _is_integer(maximum) and len(value) > maximum:
            raise ToolError(f"{path} must contain at most {maximum} items")
        item_schema = schema.get("items")
        if isinstance(item_schema, Mapping):
            for index, item in enumerate(value):
                _validate_schema(item, item_schema, path=f"{path}[{index}]")

    if expected == "string" and isinstance(value, str):
        minimum = schema.get("minLength")
        maximum = schema.get("maxLength")
        if _is_integer(minimum) and len(value) < minimum:
            raise ToolError(f"{path} must contain at least {minimum} characters")
        if _is_integer(maximum) and len(value) > maximum:
            raise ToolError(f"{path} must contain at most {maximum} characters")
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            try:
                matches = re.search(pattern, value) is not None
            except re.error:
                matches = True
            if not matches:
                raise ToolError(f"{path} does not match the required pattern")

    if expected in {"integer", "number"} and _is_number(value):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        exclusive_minimum = schema.get("exclusiveMinimum")
        exclusive_maximum = schema.get("exclusiveMaximum")
        if _is_number(minimum) and value < minimum:
            raise ToolError(f"{path} must be at least {minimum}")
        if _is_number(maximum) and value > maximum:
            raise ToolError(f"{path} must be at most {maximum}")
        if _is_number(exclusive_minimum) and value <= exclusive_minimum:
            raise ToolError(f"{path} must be greater than {exclusive_minimum}")
        if _is_number(exclusive_maximum) and value >= exclusive_maximum:
            raise ToolError(f"{path} must be less than {exclusive_maximum}")


def _matches_type(value: Any, expected: str) -> bool:
    return {
        "object": lambda item: isinstance(item, Mapping),
        "array": lambda item: isinstance(item, (list, tuple)),
        "string": lambda item: isinstance(item, str),
        "integer": _is_integer,
        "number": _is_number,
        "boolean": lambda item: isinstance(item, bool),
        "null": lambda item: item is None,
    }.get(expected, lambda _item: True)(value)


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and (not isinstance(value, float) or math.isfinite(value))
    )


def _type_label(expected: str) -> str:
    return {
        "object": "an object",
        "array": "an array",
        "string": "a string",
        "integer": "an integer",
        "number": "a number",
        "boolean": "a boolean",
        "null": "null",
    }.get(expected, expected)

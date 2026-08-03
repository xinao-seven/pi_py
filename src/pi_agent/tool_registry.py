"""Runtime tool registration and activation.

中文说明：工具注册表：登记工具、维护“当前激活”集合、生成给模型的工具定义，
并在执行前按 JSON Schema 子集校验参数。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
import math
import re
from typing import Any, Literal

from pi_agent.types import AgentTool, ToolError, ToolResult


class ToolRegistry:
    """按名称管理 AgentTool：注册、启停、导出声明与执行调用。"""
    def __init__(self, tools: Iterable[AgentTool] = ()) -> None:
        self._tools: dict[str, AgentTool] = {}
        self._active: list[str] = []
        for tool in tools:
            self.register(tool)

    def register(self, tool: AgentTool, *, active: bool = True) -> None:
        """注册一个工具；默认同时激活。重复注册会报错。"""
        if tool.name in self._tools:
            raise ValueError(f"Tool already registered: {tool.name}")
        self._tools[tool.name] = tool
        if active:
            self._active.append(tool.name)

    def set_active(self, names: Iterable[str]) -> None:
        """设置激活工具列表（保持传入顺序并去重），未知名称直接报错。"""
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
        """导出当前激活工具的 Provider 定义（供模型看到可调用工具）。"""
        return [self._tools[name].provider_definition() for name in self._active]

    def execution_mode(self, name: str) -> Literal["sequential", "parallel"] | None:
        """Return a tool's scheduling constraint without exposing its executor.

        中文说明：返回工具调度约束（串行/并行），不暴露执行器本身。
        """

        tool = self._tools.get(name)
        if tool is None or name not in self._active:
            return None
        return tool.execution_mode

    async def execute(self, tool_call_id: str, name: str, arguments: Mapping[str, Any]) -> ToolResult:
        """执行一次工具调用：校验工具激活状态与参数 Schema，然后调用执行函数。"""
        del tool_call_id
        if name not in self._active:
            raise ToolError(f"Tool is not active: {name}")
        if not isinstance(arguments, Mapping):
            raise ToolError("Tool arguments must be an object")
        tool = self._tools[name]
        _validate_schema(arguments, tool.input_schema, path="Tool arguments")
        return await tool.execute(arguments)


def _validate_schema(value: Any, schema: Mapping[str, Any], *, path: str) -> None:
    """Validate the JSON Schema subset used by Agent tool definitions.

    中文说明：校验模型传入的工具参数是否满足声明中使用的 JSON Schema 子集
    （enum/type/required/additionalProperties/长度与数值边界等），失败抛 ToolError。
    """

    if not isinstance(schema, Mapping):
        return
    if "enum" in schema and isinstance(schema["enum"], list) and value not in schema["enum"]:
        # 枚举约束：值必须落在枚举列表内
        choices = ", ".join(repr(item) for item in schema["enum"])
        raise ToolError(f"{path} must be one of: {choices}")

    expected = schema.get("type")
    if isinstance(expected, list):
        # type 允许联合类型（如 ["string","null"]）：命中任一即可
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
            # required：必填字段缺失时报错
            for key in required:
                if isinstance(key, str) and key not in value:
                    raise ToolError(f"{path}.{key} is required")
        if schema.get("additionalProperties") is False:
            # additionalProperties=false：出现未声明字段时报错
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
    """按期望类型名判断值是否匹配（bool 不视为 int，NaN/Inf 不视为 number）。"""
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
    """严格整数判断：bool 不算整数。"""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    """数字判断：bool 与无穷/NaN 不算数。"""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and (not isinstance(value, float) or math.isfinite(value))
    )


def _type_label(expected: str) -> str:
    """类型名转错误信息里的英文标签。"""
    return {
        "object": "an object",
        "array": "an array",
        "string": "a string",
        "integer": "an integer",
        "number": "a number",
        "boolean": "a boolean",
        "null": "null",
    }.get(expected, expected)

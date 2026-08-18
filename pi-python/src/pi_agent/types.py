"""General-purpose Agent types built on pi_ai primitives.

中文说明：在 pi_ai 的原子类型之上扩展出“可执行工具”相关类型：
ToolResult 工具执行结果、AgentTool 带执行函数的工具、ToolError 用户可见的工具错误。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Mapping, TypeAlias

from pi_ai.types import Tool

JsonObject: TypeAlias = dict[str, Any]
ToolExecutor: TypeAlias = Callable[[Mapping[str, Any]], Awaitable["ToolResult"]]


class ToolError(Exception):
    """A user-visible tool validation or execution failure.

    中文说明：工具校验或执行失败时抛出的、可以展示给用户看的错误。
    """


@dataclass(frozen=True, slots=True)
class ToolResult:
    """工具执行结果：content 是统一内容块，details 存结构化细节，is_error 标记失败。"""
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
        # 便捷构造：把纯文本包装成标准 text 内容块
        return cls(content=[{"type": "text", "text": text}], details=details, is_error=is_error)


@dataclass(frozen=True, slots=True)
class AgentTool(Tool):
    """在 pi_ai.Tool 基础上加上可执行函数与调度约束。
    label 用于 UI 展示；execution_mode 可覆盖全局并行/串行策略。"""
    label: str
    execute: ToolExecutor = field(repr=False, compare=False)
    execution_mode: Literal["sequential", "parallel"] | None = None


# 过渡别名：等编程助手层补充展示字段后替换为完整类型
ToolDefinition = AgentTool

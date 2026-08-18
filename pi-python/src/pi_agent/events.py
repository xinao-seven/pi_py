"""Agent event helpers shared by the runtime and HTTP boundary.

中文说明：Agent 运行时与 HTTP 边界共用的轻量事件结构。
事件由 type + payload 组成；to_dict 做深拷贝，避免事件发布后内部状态被意外修改。
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class AgentEvent:
    """统一 Agent 事件：type 表示事件类型（message_start/update/end、turn_start/end、
    tool_execution_start/end、agent_start/end 等），payload 携带事件数据。"""
    type: str
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """转为可序列化字典（深拷贝 payload）。"""
        return {"type": self.type, **deepcopy(self.payload)}

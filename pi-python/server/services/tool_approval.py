"""Human approval gate for dangerous shell commands.

中文说明：危险命令人工确认门（对应原版 pi 的 permission-gate 扩展）：

- 通过正则规则识别 bash 工具中的危险命令（递归删除、格式化、关机、提权等）；
- 命中时广播 `tool_call_pending` 事件并挂起工具执行，等待用户通过
  `approve_tool` 命令给出允许/拒绝；超时默认拒绝（安全优先）；
- 非危险工具调用直接放行，不影响正常 Agent 循环。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
import re
from typing import Any

# 审批超时（秒）：超时未收到用户响应按“拒绝”处理
DEFAULT_APPROVAL_TIMEOUT_SECONDS = 60.0


@dataclass(frozen=True, slots=True)
class DangerousRule:
    """一条危险命令规则：pattern 匹配命令（忽略大小写与多余空白）。"""
    name: str
    pattern: str
    reason: str

    def match(self, command: str) -> bool:
        """规范化命令后做正则匹配：转小写、合并空白、去掉两端空白。"""
        normalized = re.sub(r"\s+", " ", command.strip().lower())
        return re.search(self.pattern, normalized) is not None


# 跨平台危险命令黑名单（PowerShell 与 POSIX 双覆盖）。
# 规则故意保守：宁可多拦一次，也不放行破坏性命令。
DANGEROUS_RULES: tuple[DangerousRule, ...] = (
    DangerousRule(
        "privileged-delete",
        r"sudo\s+.*\b(rm|del|remove-item)\b",
        "使用提权执行删除命令，影响范围超出当前工作区",
    ),
    DangerousRule(
        "recursive-delete",
        r"(^|\b)(rm|rmdir|rd|del|remove-item)(\s|/).*(-rf|-fr|--recursive|-recurse|/s)(\s|$)",
        "递归/强制删除文件或目录，可能造成不可恢复的数据丢失",
    ),
    DangerousRule(
        "force-delete",
        r"(^|\b)remove-item(\s|/).*(-force|/f)(\s|$)",
        "强制删除文件或目录，可能造成不可恢复的数据丢失",
    ),
    DangerousRule(
        "disk-format",
        r"(^|\b)(format|format-volume|mkfs|mkfs\.[a-z0-9]+|fdisk|diskpart)([.\s]|$)",
        "磁盘/分区格式化或分区表操作，会销毁磁盘数据",
    ),
    DangerousRule(
        "raw-disk-write",
        r"(^|\b)dd(\s+.*)?\s+of=/(dev/(sd|hd)|dev)\b|>\s*/dev/(sd|hd)",
        "直接向磁盘设备写入数据，会覆盖磁盘内容",
    ),
    DangerousRule(
        "shutdown",
        r"(^|\b)(shutdown|restart-computer|stop-computer|reboot|poweroff)(\s|$)",
        "关机/重启/断电命令，会中断当前机器",
    ),
    DangerousRule(
        "force-push",
        r"git\s+(push|fetch)\s+.*(-f|--force)\b",
        "强制推送/拉取 Git 历史，可能覆盖远端提交",
    ),
    DangerousRule(
        "bulk-uninstall",
        r"(^|\b)(pip|npm|conda|apt|apt-get|dnf|yum)\s+(uninstall|remove|purge)(\s|$).*(-y\b|--yes\b|-y$)",
        "批量卸载软件包，可能破坏开发环境",
    ),
    DangerousRule(
        "pipe-remote-script",
        r"(curl|wget|iwr|invoke-webrequest|invoke-restmethod)[^\n|]*\s*\|\s*(sh|bash|zsh|iex|powershell)",
        "把远程脚本直接管道执行，可能运行未知代码",
    ),
    DangerousRule(
        "recursive-chmod",
        r"chmod\s+(-r\s+)?777\s+/\s*$|chown\s+(-r\s+)?[^\s]+\s+/",
        "对根目录递归修改权限/属主，可能使系统不可用",
    ),
    DangerousRule(
        "registry-delete",
        r"(^|\b)reg\s+delete\b",
        "删除 Windows 注册表项，可能损坏系统配置",
    ),
    DangerousRule(
        "fork-bomb",
        r":\(\)\s*\{.*\|.*&.*\}",
        "fork 炸弹会使系统资源耗尽",
    ),
)


def find_dangerous_rule(
    tool_name: str,
    arguments: dict[str, Any],
) -> DangerousRule | None:
    """在工具调用参数里查找危险命令；只检查 bash 工具，返回第一条命中规则。"""
    if tool_name != "bash":
        return None
    command = arguments.get("command")
    if not isinstance(command, str):
        return None
    for rule in DANGEROUS_RULES:
        if rule.match(command):
            return rule
    return None


class ToolApprovalGate:
    """按 tool_call_id 管理待确认请求：广播 pending 事件，等待用户允许/拒绝。

    中文说明：approve 由 Agent 循环在工具执行前调用；resolve 由 HTTP 命令
    （approve_tool）调用；pending 通过绑定的事件发布器广播给 SSE 订阅者。
    """

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_APPROVAL_TIMEOUT_SECONDS,
        rules: tuple[DangerousRule, ...] = DANGEROUS_RULES,
        publish: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.timeout = timeout
        self.rules = rules
        self._publish = publish
        self._pending: dict[str, asyncio.Future[bool]] = {}

    def bind_publisher(self, publish: Callable[[dict[str, Any]], None]) -> None:
        """绑定事件发布器（RegistryEntry 创建后调用），用于广播 pending 事件。"""
        self._publish = publish

    async def approve(
        self,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> bool:
        """审批一次工具调用：非危险直接放行；危险则挂起等待人工确认。"""
        rule = self._matching_rule(tool_name, arguments)
        if rule is None:
            return True
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()
        self._pending[tool_call_id] = future
        if self._publish is not None:
            self._publish(
                {
                    "type": "tool_call_pending",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "reason": rule.reason,
                    "rule": rule.name,
                    "args": arguments,
                }
            )
        try:
            return await asyncio.wait_for(future, timeout=self.timeout)
        except asyncio.TimeoutError:
            # 超时未确认：默认拒绝（安全优先）
            return False
        except asyncio.CancelledError:
            # Agent 被中止：清理挂起项后向上传播
            self._pending.pop(tool_call_id, None)
            future.cancel()
            raise
        finally:
            self._pending.pop(tool_call_id, None)

    def resolve(self, tool_call_id: str, approved: bool) -> bool:
        """对挂起的工具调用给出允许/拒绝；无挂起项返回 False。"""
        future = self._pending.get(tool_call_id)
        if future is None or future.done():
            return False
        future.set_result(approved)
        return True

    def cancel_all(self) -> None:
        """清空全部挂起项（应用关闭/Agent 回收时调用），统一按拒绝处理。"""
        for future in self._pending.values():
            if not future.done():
                future.set_result(False)
        self._pending.clear()

    @property
    def pending_count(self) -> int:
        """当前等待人工确认的工具调用数量。"""
        return len(self._pending)

    def _matching_rule(
        self,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> DangerousRule | None:
        if tool_name != "bash":
            return None
        command = arguments.get("command")
        if not isinstance(command, str):
            return None
        for rule in self.rules:
            if rule.match(command):
                return rule
        return None

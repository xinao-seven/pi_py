"""Concrete tools for a coding assistant.

中文说明：编程助手的具象工具集合：read/write/edit/ls、bash、grep/find。
create_builtin_tools 一次性组装全部内置工具。
"""

from pathlib import Path

from pi_agent.types import AgentTool
from pi_coding_agent.tools.bash import create_bash_tool
from pi_coding_agent.tools.file_tools import (
    create_edit_tool,
    create_file_tools,
    create_ls_tool,
    create_read_tool,
    create_write_tool,
)
from pi_coding_agent.tools.paths import WorkspacePaths
from pi_coding_agent.tools.search_tools import create_find_tool, create_grep_tool


def create_builtin_tools(workspace: str | Path) -> list[AgentTool]:
    """创建全部内置工具（基于同一个工作区路径边界）。"""
    paths = WorkspacePaths(workspace)
    return [
        create_read_tool(paths),
        create_bash_tool(workspace),
        create_edit_tool(paths),
        create_write_tool(paths),
        create_grep_tool(paths),
        create_find_tool(paths),
        create_ls_tool(paths),
    ]


__all__ = ["create_builtin_tools", "create_file_tools"]

"""Portable grep and find tools with bounded output.

中文说明：搜索工具：grep（按正则/字面量搜文件内容，带上下文行）
与 find（按 glob 找文件）。递归时跳过 .git/node_modules/__pycache__。
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath
import re
from typing import Any, Iterable, Mapping

from pi_agent.types import JsonObject, ToolDefinition, ToolError, ToolResult
from pi_coding_agent.tools.file_tools import DEFAULT_MAX_BYTES, _object_schema, _positive_int, _truncate_head
from pi_coding_agent.tools.paths import WorkspacePaths

DEFAULT_GREP_LIMIT = 100
DEFAULT_FIND_LIMIT = 1_000
MAX_MATCH_LINE_LENGTH = 500
IGNORED_DIRECTORY_NAMES = {".git", "node_modules", "__pycache__"}


def _files_under(path: Path) -> Iterable[Path]:
    """递归枚举路径下的文件，跳过忽略目录。"""
    if path.is_file():
        yield path
        return
    for candidate in path.rglob("*"):
        if any(part in IGNORED_DIRECTORY_NAMES for part in candidate.relative_to(path).parts):
            continue
        if candidate.is_file():
            yield candidate


def _relative_posix(path: Path, root: Path) -> str:
    if root.is_file():
        return path.name
    return path.relative_to(root).as_posix()


def _matches_glob(relative_path: str, pattern: str | None) -> bool:
    return pattern is None or PurePosixPath(relative_path).match(pattern)


def create_find_tool(paths: WorkspacePaths) -> ToolDefinition:
    """创建 find 工具：按 glob 匹配相对路径，结果排序并限制数量。"""
    async def execute(arguments: Mapping[str, Any]) -> ToolResult:
        pattern = arguments.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ToolError("pattern must be a non-empty string")
        root = paths.resolve(arguments.get("path", "."), must_exist=True)
        if not root.is_dir():
            raise ToolError(f"Not a directory: {arguments.get('path', '.')}")
        limit = _positive_int(arguments.get("limit"), "limit", default=DEFAULT_FIND_LIMIT)
        assert limit is not None
        all_results: list[str] = []
        for candidate in _files_under(root):
            relative = _relative_posix(candidate, root)
            if not _matches_glob(relative, pattern):
                continue
            all_results.append(relative)
        all_results.sort(key=str.casefold)
        limit_reached = len(all_results) > limit
        results = all_results[:limit]
        if not results:
            return ToolResult.text("No files found matching pattern")
        output, truncation = _truncate_head("\n".join(results), max_lines=2**31 - 1)
        details: JsonObject = {}
        notices: list[str] = []
        if limit_reached:
            details["resultLimitReached"] = limit
            notices.append(f"{limit} results limit reached")
        if truncation:
            details["truncation"] = truncation
            notices.append(f"{DEFAULT_MAX_BYTES} byte limit reached")
        if notices:
            output += f"\n\n[{'. '.join(notices)}.]"
        return ToolResult.text(output, details=details or None)

    return ToolDefinition(
        name="find",
        label="find",
        description=(
            "Find files by glob pattern inside the workspace. Returns paths relative to the search directory "
            "and ignores .git, node_modules, and __pycache__."
        ),
        input_schema=_object_schema(
            {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1},
            },
            ["pattern"],
        ),
        execute=execute,
    )


def _nonnegative_int(value: object, field: str, default: int = 0) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ToolError(f"{field} must be a non-negative integer")
    return value


def create_grep_tool(paths: WorkspacePaths) -> ToolDefinition:
    """创建 grep 工具：支持正则/字面量、忽略大小写、glob 过滤、
    上下文行数与结果上限；超长匹配行截断显示。"""
    async def execute(arguments: Mapping[str, Any]) -> ToolResult:
        pattern = arguments.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ToolError("pattern must be a non-empty string")
        root = paths.resolve(arguments.get("path", "."), must_exist=True)
        glob = arguments.get("glob")
        if glob is not None and not isinstance(glob, str):
            raise ToolError("glob must be a string")
        ignore_case = arguments.get("ignoreCase", False)
        literal = arguments.get("literal", False)
        if not isinstance(ignore_case, bool) or not isinstance(literal, bool):
            raise ToolError("ignoreCase and literal must be booleans")
        context_lines = _nonnegative_int(arguments.get("context"), "context")
        limit = _positive_int(arguments.get("limit"), "limit", default=DEFAULT_GREP_LIMIT)
        assert limit is not None
        expression = re.escape(pattern) if literal else pattern
        try:
            compiled = re.compile(expression, re.IGNORECASE if ignore_case else 0)
        except re.error as error:
            raise ToolError(f"Invalid regular expression: {error}") from error

        output_lines: list[str] = []
        match_count = 0
        lines_truncated = False
        limit_reached = False
        for file_path in _files_under(root):
            relative = _relative_posix(file_path, root)
            if not _matches_glob(relative, glob):
                continue
            try:
                data = file_path.read_bytes()
                if b"\x00" in data:
                    # 跳过二进制文件
                    continue
                lines = data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").split("\n")
            except (OSError, UnicodeDecodeError):
                # 读取失败或非 UTF-8 的文件跳过，不中断整个搜索
                continue
            emitted_context: set[int] = set()
            for index, line in enumerate(lines):
                if not compiled.search(line):
                    continue
                if match_count >= limit:
                    limit_reached = True
                    break
                # 输出匹配行及上下文行；: 表示命中行，- 表示上下文行
                start = max(0, index - context_lines)
                end = min(len(lines), index + context_lines + 1)
                for line_index in range(start, end):
                    if line_index in emitted_context:
                        continue
                    rendered = lines[line_index]
                    if len(rendered) > MAX_MATCH_LINE_LENGTH:
                        rendered = rendered[:MAX_MATCH_LINE_LENGTH] + "…"
                        lines_truncated = True
                    marker = ":" if line_index == index else "-"
                    output_lines.append(f"{relative}{marker}{line_index + 1}{marker}{rendered}")
                    emitted_context.add(line_index)
                match_count += 1
            if limit_reached:
                break
        if not output_lines:
            return ToolResult.text("No matches found")
        output, truncation = _truncate_head("\n".join(output_lines), max_lines=2**31 - 1)
        details: JsonObject = {}
        if limit_reached:
            details["matchLimitReached"] = limit
        if lines_truncated:
            details["linesTruncated"] = True
        if truncation:
            details["truncation"] = truncation
        return ToolResult.text(output, details=details or None)

    return ToolDefinition(
        name="grep",
        label="grep",
        description=(
            "Search UTF-8 file contents with a regex or literal pattern. Returns relative paths, line numbers, "
            "and optional context lines."
        ),
        input_schema=_object_schema(
            {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "glob": {"type": "string"},
                "ignoreCase": {"type": "boolean"},
                "literal": {"type": "boolean"},
                "context": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1},
            },
            ["pattern"],
        ),
        execute=execute,
    )

"""Read, write, edit, and directory-listing tools.

中文说明：文件工具：read（分页读 UTF-8 文本）、write（整体覆盖）、
edit（精确唯一替换）、ls（目录列表）。所有路径经 WorkspacePaths 边界校验。
"""

from __future__ import annotations

import difflib
from pathlib import Path
from typing import Any, Mapping

from pi_agent.types import JsonObject, ToolDefinition, ToolError, ToolResult
from pi_coding_agent.tools.paths import WorkspacePaths

DEFAULT_MAX_LINES = 2_000
DEFAULT_MAX_BYTES = 50 * 1024
DEFAULT_LS_LIMIT = 500


def _object_schema(properties: JsonObject, required: list[str]) -> JsonObject:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _positive_int(value: object, field: str, *, default: int | None = None) -> int | None:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ToolError(f"{field} must be a positive integer")
    return value


def _truncate_head(
    text: str,
    *,
    max_lines: int = DEFAULT_MAX_LINES,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> tuple[str, JsonObject | None]:
    """按行数/字节数从头部截断输出，返回截断信息。"""
    lines = text.split("\n")
    output: list[str] = []
    output_bytes = 0
    truncated_by: str | None = None
    for line in lines:
        if len(output) >= max_lines:
            truncated_by = "lines"
            break
        encoded = line.encode("utf-8")
        separator_bytes = 1 if output else 0
        if output_bytes + separator_bytes + len(encoded) > max_bytes:
            truncated_by = "bytes"
            break
        output.append(line)
        output_bytes += separator_bytes + len(encoded)
    content = "\n".join(output)
    if truncated_by is None:
        return content, None
    return content, {
        "truncated": True,
        "truncatedBy": truncated_by,
        "totalLines": len(lines),
        "outputLines": len(output),
        "maxLines": max_lines,
        "maxBytes": max_bytes,
    }


def _require_text(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ToolError(f"{field} must be a string")
    return value


def _decode_text(path: Path) -> str:
    """读取 UTF-8 文本：先拒绝含 NUL 的二进制文件，再校验编码。"""
    data = path.read_bytes()
    if b"\x00" in data:
        raise ToolError(f"Binary files are not supported yet: {path.name}")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ToolError(f"File is not valid UTF-8: {path.name}") from error


def create_read_tool(paths: WorkspacePaths) -> ToolDefinition:
    """创建 read 工具：1 起始的 offset 与 limit 分页，超过上限提示继续读取。"""
    async def execute(arguments: Mapping[str, Any]) -> ToolResult:
        path = paths.resolve(arguments.get("path"), must_exist=True)
        if not path.is_file():
            raise ToolError(f"Not a file: {arguments.get('path')}")
        offset = _positive_int(arguments.get("offset"), "offset", default=1)
        limit = _positive_int(arguments.get("limit"), "limit")
        text = _decode_text(path)
        all_lines = text.split("\n")
        assert offset is not None
        start = offset - 1
        if start >= len(all_lines):
            raise ToolError(f"Offset {offset} is beyond end of file ({len(all_lines)} lines total)")
        end = min(start + limit, len(all_lines)) if limit is not None else len(all_lines)
        selected = "\n".join(all_lines[start:end])
        output, truncation = _truncate_head(selected)
        details = {"truncation": truncation} if truncation else None
        if truncation:
            next_offset = start + truncation["outputLines"] + 1
            output += f"\n\n[Showing part of {len(all_lines)} lines. Use offset={next_offset} to continue.]"
        elif limit is not None and end < len(all_lines):
            output += f"\n\n[{len(all_lines) - end} more lines in file. Use offset={end + 1} to continue.]"
        return ToolResult.text(output, details=details)

    return ToolDefinition(
        name="read",
        label="read",
        description=(
            "Read a UTF-8 text file. Paths must stay inside the workspace. "
            "offset is 1-indexed and limit restricts returned lines."
        ),
        input_schema=_object_schema(
            {
                "path": {"type": "string", "description": "Workspace-relative file path"},
                "offset": {"type": "integer", "minimum": 1},
                "limit": {"type": "integer", "minimum": 1},
            },
            ["path"],
        ),
        execute=execute,
    )


def create_write_tool(paths: WorkspacePaths) -> ToolDefinition:
    """创建 write 工具：完全覆盖目标文件（自动创建父目录，加写锁）。"""
    async def execute(arguments: Mapping[str, Any]) -> ToolResult:
        path = paths.resolve(arguments.get("path"))
        content = _require_text(arguments.get("content"), "content")
        async with paths.mutation_lock(path):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="")
        return ToolResult.text(
            f"Successfully wrote {len(content.encode('utf-8'))} bytes to {arguments.get('path')}"
        )

    return ToolDefinition(
        name="write",
        label="write",
        description="Create or completely overwrite a UTF-8 text file inside the workspace.",
        input_schema=_object_schema(
            {
                "path": {"type": "string", "description": "Workspace-relative file path"},
                "content": {"type": "string", "description": "Complete file content"},
            },
            ["path", "content"],
        ),
        execute=execute,
    )


def _validated_edits(arguments: Mapping[str, Any]) -> list[tuple[str, str]]:
    """校验并规范化编辑列表：兼容旧版 oldText/newText 单块写法。"""
    raw_edits = arguments.get("edits")
    if raw_edits is None and ("oldText" in arguments or "newText" in arguments):
        raw_edits = [{"oldText": arguments.get("oldText"), "newText": arguments.get("newText")}]
    if not isinstance(raw_edits, list) or not raw_edits:
        raise ToolError("edits must be a non-empty array")
    edits: list[tuple[str, str]] = []
    for index, raw in enumerate(raw_edits):
        if not isinstance(raw, dict):
            raise ToolError(f"edits[{index}] must be an object")
        old = _require_text(raw.get("oldText"), f"edits[{index}].oldText")
        new = _require_text(raw.get("newText"), f"edits[{index}].newText")
        if not old:
            raise ToolError(f"edits[{index}].oldText must not be empty")
        edits.append((old.replace("\r\n", "\n"), new.replace("\r\n", "\n")))
    return edits


def create_edit_tool(paths: WorkspacePaths) -> ToolDefinition:
    """创建 edit 工具：对原文做唯一、精确、不重叠的替换，
    保留 BOM 与换行风格，并返回 unified diff 供模型查看。"""
    async def execute(arguments: Mapping[str, Any]) -> ToolResult:
        path = paths.resolve(arguments.get("path"), must_exist=True)
        if not path.is_file():
            raise ToolError(f"Not a file: {arguments.get('path')}")
        edits = _validated_edits(arguments)
        async with paths.mutation_lock(path):
            raw = _decode_text(path)
            bom = "\ufeff" if raw.startswith("\ufeff") else ""
            without_bom = raw[len(bom) :]
            ending = "\r\n" if "\r\n" in without_bom else "\n"
            original = without_bom.replace("\r\n", "\n")
            ranges: list[tuple[int, int, str]] = []
            for old, new in edits:
                count = original.count(old)
                if count == 0:
                    raise ToolError("oldText was not found in the file")
                if count > 1:
                    raise ToolError("oldText must match exactly one location in the file")
                start = original.index(old)
                ranges.append((start, start + len(old), new))
            ordered = sorted(ranges)
            if any(current[0] < previous[1] for previous, current in zip(ordered, ordered[1:])):
                raise ToolError("edits must not overlap")
            changed = original
            for start, end, replacement in reversed(ordered):
                changed = changed[:start] + replacement + changed[end:]
            final = bom + (changed.replace("\n", ending) if ending != "\n" else changed)
            path.write_text(final, encoding="utf-8", newline="")
        diff = "\n".join(
            difflib.unified_diff(
                original.splitlines(),
                changed.splitlines(),
                fromfile=str(arguments.get("path")),
                tofile=str(arguments.get("path")),
                lineterm="",
            )
        )
        return ToolResult.text(
            f"Successfully replaced {len(edits)} block(s) in {arguments.get('path')}.",
            details={"diff": diff},
        )

    edit_item = _object_schema(
        {"oldText": {"type": "string"}, "newText": {"type": "string"}},
        ["oldText", "newText"],
    )
    return ToolDefinition(
        name="edit",
        label="edit",
        description=(
            "Edit one UTF-8 text file using unique, exact, non-overlapping replacements "
            "matched against the original content."
        ),
        input_schema=_object_schema(
            {
                "path": {"type": "string"},
                "edits": {"type": "array", "minItems": 1, "items": edit_item},
            },
            ["path", "edits"],
        ),
        execute=execute,
    )


def create_ls_tool(paths: WorkspacePaths) -> ToolDefinition:
    """创建 ls 工具：按名称排序列出目录项，目录以 '/' 结尾，可限制条数。"""
    async def execute(arguments: Mapping[str, Any]) -> ToolResult:
        raw_path = arguments.get("path", ".")
        path = paths.resolve(raw_path, must_exist=True)
        if not path.is_dir():
            raise ToolError(f"Not a directory: {raw_path}")
        limit = _positive_int(arguments.get("limit"), "limit", default=DEFAULT_LS_LIMIT)
        assert limit is not None
        entries = sorted(path.iterdir(), key=lambda item: item.name.casefold())
        selected = entries[:limit]
        output = "\n".join(item.name + ("/" if item.is_dir() else "") for item in selected)
        if not output:
            return ToolResult.text("(empty directory)")
        details = None
        if len(entries) > limit:
            output += f"\n\n[{limit} entries limit reached. Use limit={limit * 2} for more.]"
            details = {"entryLimitReached": limit}
        output, truncation = _truncate_head(output, max_lines=2**31 - 1)
        if truncation:
            details = {**(details or {}), "truncation": truncation}
        return ToolResult.text(output, details=details)

    return ToolDefinition(
        name="ls",
        label="ls",
        description="List workspace directory entries alphabetically; directories have a '/' suffix.",
        input_schema=_object_schema(
            {
                "path": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1},
            },
            [],
        ),
        execute=execute,
    )


def create_file_tools(workspace: str | Path) -> list[ToolDefinition]:
    """创建文件类工具集合（read/write/edit/ls）。"""
    paths = WorkspacePaths(workspace)
    return [
        create_read_tool(paths),
        create_write_tool(paths),
        create_edit_tool(paths),
        create_ls_tool(paths),
    ]

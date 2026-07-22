"""Cross-platform subprocess tool."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, Mapping

from pi_agent.types import JsonObject, ToolDefinition, ToolError, ToolResult
from pi_coding_agent.tools.file_tools import DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, _object_schema


def _truncate_tail(text: str) -> tuple[str, JsonObject | None]:
    lines = text.split("\n")
    kept: list[str] = []
    kept_bytes = 0
    for line in reversed(lines):
        encoded_size = len(line.encode("utf-8")) + (1 if kept else 0)
        if len(kept) >= DEFAULT_MAX_LINES or kept_bytes + encoded_size > DEFAULT_MAX_BYTES:
            break
        kept.append(line)
        kept_bytes += encoded_size
    if len(kept) == len(lines):
        return text, None
    kept.reverse()
    return "\n".join(kept), {
        "truncated": True,
        "truncatedBy": "lines" if len(kept) >= DEFAULT_MAX_LINES else "bytes",
        "totalLines": len(lines),
        "outputLines": len(kept),
        "maxLines": DEFAULT_MAX_LINES,
        "maxBytes": DEFAULT_MAX_BYTES,
    }


def create_bash_tool(workspace: str | Path) -> ToolDefinition:
    cwd = Path(workspace).resolve()

    async def execute(arguments: Mapping[str, Any]) -> ToolResult:
        command = arguments.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ToolError("command must be a non-empty string")
        timeout = arguments.get("timeout")
        if timeout is not None and (
            isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0
        ):
            raise ToolError("timeout must be a positive number of seconds")
        if os.name == "nt":
            argv = ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
            creationflags = 0x08000000
        else:
            argv = [os.environ.get("SHELL", "/bin/sh"), "-lc", command]
            creationflags = 0
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                creationflags=creationflags,
            )
        except OSError as error:
            raise ToolError(f"Could not start shell: {error}") from error
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=float(timeout) if timeout else None)
        except TimeoutError as error:
            process.kill()
            await process.communicate()
            raise ToolError(f"Command timed out after {timeout} seconds") from error
        except asyncio.CancelledError:
            process.kill()
            await process.communicate()
            raise
        output = stdout.decode("utf-8", errors="replace").replace("\r\n", "\n")
        output, truncation = _truncate_tail(output)
        if not output:
            output = "(no output)"
        details: JsonObject = {"exitCode": process.returncode}
        if truncation:
            details["truncation"] = truncation
            output = f"[Output truncated; showing tail]\n{output}"
        if process.returncode:
            output += f"\n\nCommand exited with code {process.returncode}"
        return ToolResult.text(output, details=details)

    return ToolDefinition(
        name="bash",
        label="bash",
        description=(
            "Execute a shell command in the workspace and return combined stdout/stderr. "
            "On Windows this uses PowerShell; on POSIX it uses the configured shell."
        ),
        input_schema=_object_schema(
            {
                "command": {"type": "string"},
                "timeout": {"type": "number", "exclusiveMinimum": 0},
            },
            ["command"],
        ),
        execute=execute,
    )

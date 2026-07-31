import asyncio
import os
from pathlib import Path

import pytest

from pi_agent import AgentTool, ToolError, ToolRegistry, ToolResult
from pi_coding_agent.tools import create_builtin_tools, create_file_tools


@pytest.fixture
def registry(tmp_path: Path) -> ToolRegistry:
    return ToolRegistry(create_file_tools(tmp_path))


def text(result: object) -> str:
    return result.content[0]["text"]


def call(registry: ToolRegistry, tool_call_id: str, name: str, arguments: dict[str, object]):
    return asyncio.run(registry.execute(tool_call_id, name, arguments))


def test_write_read_and_offset_limit(registry: ToolRegistry, tmp_path: Path) -> None:
    call(registry, "1", "write", {"path": "docs/hello.txt", "content": "一\ntwo\nthree"})

    result = call(registry, "2", "read", {"path": "docs/hello.txt", "offset": 2, "limit": 1})

    assert (tmp_path / "docs" / "hello.txt").read_text(encoding="utf-8") == "一\ntwo\nthree"
    assert text(result).startswith("two")
    assert "offset=3" in text(result)


def test_read_rejects_invalid_offset_and_binary(registry: ToolRegistry, tmp_path: Path) -> None:
    (tmp_path / "short.txt").write_text("one", encoding="utf-8")
    (tmp_path / "binary.bin").write_bytes(b"a\x00b")

    with pytest.raises(ToolError, match="beyond end"):
        call(registry, "1", "read", {"path": "short.txt", "offset": 2})
    with pytest.raises(ToolError, match="Binary"):
        call(registry, "2", "read", {"path": "binary.bin"})


def test_workspace_boundary_blocks_escape(registry: ToolRegistry, tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside.txt"

    with pytest.raises(ToolError, match="outside the workspace"):
        call(registry, "1", "write", {"path": str(outside), "content": "blocked"})
    assert not outside.exists()


def test_edit_requires_unique_match_and_preserves_crlf(registry: ToolRegistry, tmp_path: Path) -> None:
    target = tmp_path / "app.py"
    target.write_bytes(b"one\r\ntwo\r\nthree\r\n")

    result = call(
        registry,
        "1",
        "edit",
        {"path": "app.py", "edits": [{"oldText": "two", "newText": "TWO"}]},
    )

    assert target.read_bytes() == b"one\r\nTWO\r\nthree\r\n"
    assert "-two" in result.details["diff"]
    target.write_text("same same", encoding="utf-8")
    with pytest.raises(ToolError, match="exactly one"):
        call(
            registry,
            "2",
            "edit",
            {"path": "app.py", "edits": [{"oldText": "same", "newText": "x"}]},
        )


def test_edit_rejects_overlapping_changes(registry: ToolRegistry, tmp_path: Path) -> None:
    (tmp_path / "overlap.txt").write_text("abcdef", encoding="utf-8")

    with pytest.raises(ToolError, match="overlap"):
        call(
            registry,
            "1",
            "edit",
            {
                "path": "overlap.txt",
                "edits": [
                    {"oldText": "abcd", "newText": "A"},
                    {"oldText": "cdef", "newText": "B"},
                ],
            },
        )


def test_ls_sorts_and_marks_directories(registry: ToolRegistry, tmp_path: Path) -> None:
    (tmp_path / "z.txt").write_text("z", encoding="utf-8")
    (tmp_path / "Alpha").mkdir()
    (tmp_path / ".hidden").write_text("h", encoding="utf-8")

    result = call(registry, "1", "ls", {"limit": 2})

    assert text(result).splitlines()[:2] == [".hidden", "Alpha/"]
    assert result.details == {"entryLimitReached": 2}


def test_registry_activation_and_provider_schema(registry: ToolRegistry) -> None:
    registry.set_active(["read", "ls"])

    assert registry.active_names() == ["read", "ls"]
    assert [definition["name"] for definition in registry.definitions()] == ["read", "ls"]
    with pytest.raises(ToolError, match="not active"):
        call(registry, "1", "write", {"path": "x", "content": "x"})
    with pytest.raises(KeyError, match="Unknown tools"):
        registry.set_active(["missing"])


def test_find_and_grep_search_workspace(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "alpha.py").write_text("first\nNeedle here\nlast", encoding="utf-8")
    (tmp_path / "src" / "beta.txt").write_text("needle lower", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "ignored.py").write_text("Needle", encoding="utf-8")
    tools = ToolRegistry(create_builtin_tools(tmp_path))

    found = call(tools, "1", "find", {"pattern": "**/*.py"})
    matched = call(
        tools,
        "2",
        "grep",
        {"pattern": "needle", "path": "src", "ignoreCase": True, "glob": "*.py", "context": 1},
    )

    assert text(found) == "src/alpha.py"
    assert "alpha.py:2:Needle here" in text(matched)
    assert "alpha.py-1-first" in text(matched)
    assert "beta.txt" not in text(matched)


def test_grep_rejects_invalid_regex(tmp_path: Path) -> None:
    tools = ToolRegistry(create_builtin_tools(tmp_path))

    with pytest.raises(ToolError, match="Invalid regular expression"):
        call(tools, "1", "grep", {"pattern": "["})


def test_bash_runs_in_workspace_and_reports_exit_code(tmp_path: Path) -> None:
    tools = ToolRegistry(create_builtin_tools(tmp_path))
    command = "Write-Output (Get-Location).Path" if os.name == "nt" else "pwd"

    result = call(tools, "1", "bash", {"command": command, "timeout": 5})

    assert str(tmp_path.resolve()).casefold() in text(result).casefold()
    assert result.details["exitCode"] == 0


def test_bash_validates_timeout(tmp_path: Path) -> None:
    tools = ToolRegistry(create_builtin_tools(tmp_path))

    with pytest.raises(ToolError, match="timeout"):
        call(tools, "1", "bash", {"command": "echo x", "timeout": 0})


def test_bash_timeout_terminates_command(tmp_path: Path) -> None:
    tools = ToolRegistry(create_builtin_tools(tmp_path))
    command = "Start-Sleep -Seconds 5" if os.name == "nt" else "sleep 5"

    with pytest.raises(ToolError, match="timed out"):
        call(tools, "1", "bash", {"command": command, "timeout": 0.05})


def test_bash_task_cancellation_is_propagated(tmp_path: Path) -> None:
    tools = ToolRegistry(create_builtin_tools(tmp_path))
    command = "Start-Sleep -Seconds 5" if os.name == "nt" else "sleep 5"

    async def cancel_running_command() -> None:
        task = asyncio.create_task(tools.execute("1", "bash", {"command": command}))
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel_running_command())


def test_registry_rejects_non_object_arguments(tmp_path: Path) -> None:
    tools = ToolRegistry(create_builtin_tools(tmp_path))

    with pytest.raises(ToolError, match="must be an object"):
        asyncio.run(tools.execute("1", "ls", []))


def test_registry_validates_tool_schema_before_execution() -> None:
    calls = 0

    async def execute(_arguments) -> ToolResult:
        nonlocal calls
        calls += 1
        return ToolResult.text("ok")

    tools = ToolRegistry(
        [
            AgentTool(
                name="typed",
                label="typed",
                description="typed",
                input_schema={
                    "type": "object",
                    "properties": {
                        "count": {"type": "integer", "minimum": 1},
                        "items": {
                            "type": "array",
                            "items": {"type": "string"},
                            "minItems": 1,
                        },
                    },
                    "required": ["count", "items"],
                    "additionalProperties": False,
                },
                execute=execute,
            )
        ]
    )

    with pytest.raises(ToolError, match=r"Tool arguments\.count is required"):
        call(tools, "1", "typed", {"items": ["a"]})
    with pytest.raises(ToolError, match="unexpected argument"):
        call(tools, "2", "typed", {"count": 1, "items": ["a"], "extra": True})
    with pytest.raises(ToolError, match=r"Tool arguments\.items\[0\] must be a string"):
        call(tools, "3", "typed", {"count": 1, "items": [3]})
    with pytest.raises(ToolError, match="must be an integer"):
        call(tools, "4", "typed", {"count": True, "items": ["a"]})

    result = call(tools, "5", "typed", {"count": 1, "items": ["a"]})

    assert text(result) == "ok"
    assert calls == 1

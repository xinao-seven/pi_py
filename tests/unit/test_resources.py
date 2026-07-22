from __future__ import annotations

import asyncio
from pathlib import Path

from pi_ai import FakeProvider
from pi_agent import AgentTool, ToolRegistry, ToolResult
from pi_coding_agent import AgentSession, CodingResourceLoader, SessionManager
from pi_coding_agent.core.prompt_templates import (
    expand_prompt_template,
    load_prompt_templates,
    substitute_arguments,
)
from pi_coding_agent.core.skills import expand_skill_command, format_skills_for_prompt, load_skills
from pi_coding_agent.core.system_prompt import build_system_prompt


def run(coroutine):
    return asyncio.run(coroutine)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_skills_are_discovered_validated_and_formatted(tmp_path: Path) -> None:
    _write(
        tmp_path / ".agents" / "skills" / "review-code" / "SKILL.md",
        "---\nname: review-code\ndescription: Review code safely & clearly\n---\nRead the files first.\n",
    )
    _write(
        tmp_path / ".agents" / "skills" / "manual-only" / "SKILL.md",
        "---\nname: manual-only\ndescription: Manual command\ndisable-model-invocation: true\n---\nDo it manually.\n",
    )
    _write(
        tmp_path / ".pi" / "skills" / "broken" / "SKILL.md",
        "---\nname: Broken_Name\n---\nMissing description.\n",
    )

    result = load_skills(tmp_path)

    assert [skill.name for skill in result.skills] == ["manual-only", "review-code"]
    assert any(item.message == "description is required" for item in result.diagnostics)
    prompt = format_skills_for_prompt(result.skills)
    assert "review-code" in prompt
    assert "Review code safely &amp; clearly" in prompt
    assert "manual-only" not in prompt
    expanded = expand_skill_command("/skill:review-code focus on auth", result.skills)
    assert '<skill name="review-code"' in expanded
    assert "References are relative to" in expanded
    assert expanded.endswith("focus on auth")


def test_prompt_templates_support_quotes_defaults_and_slices(tmp_path: Path) -> None:
    _write(
        tmp_path / ".pi" / "prompts" / "review.md",
        "---\ndescription: Review a target\nargument-hint: <path> [focus]\n---\nTarget=$1 Focus=${2:-general} All=$@ Tail=${@:2}\n",
    )
    templates = load_prompt_templates(tmp_path)

    expanded = expand_prompt_template('/review "src/my app" security extra', templates)

    assert expanded.strip() == "Target=src/my app Focus=security All=src/my app security extra Tail=security extra"
    assert templates[0].argument_hint == "<path> [focus]"
    assert substitute_arguments("${1:-default}", []) == "default"
    assert expand_prompt_template("/unknown value", templates) == "/unknown value"


def test_resource_loader_orders_context_and_prefers_project_system_files(tmp_path: Path) -> None:
    workspace = tmp_path / "project" / "sub"
    workspace.mkdir(parents=True)
    _write(tmp_path / "AGENTS.md", "ancestor rules")
    _write(workspace / "AGENTS.md", "local rules")
    _write(workspace / ".pi" / "SYSTEM.md", "custom system")
    _write(workspace / ".pi" / "APPEND_SYSTEM.md", "appendix")

    resources = CodingResourceLoader(workspace).load()

    assert [content for _, content in resources.context_files] == ["ancestor rules", "local rules"]
    assert resources.system_prompt == "custom system"
    assert resources.append_system_prompt == "appendix"
    prompt = build_system_prompt(
        cwd=workspace,
        selected_tools=["read"],
        context_files=resources.context_files,
        custom_prompt=resources.system_prompt,
        append_prompt=resources.append_system_prompt,
    )
    assert prompt.index("ancestor rules") < prompt.index("local rules")
    assert prompt.startswith("custom system")
    assert "appendix" in prompt


def test_agent_session_expands_templates_and_skill_commands(tmp_path: Path) -> None:
    _write(
        tmp_path / ".agents" / "skills" / "explain" / "SKILL.md",
        "---\nname: explain\ndescription: Explain selected code\n---\nExplain from entry points.\n",
    )
    _write(tmp_path / ".pi" / "prompts" / "fix.md", "Fix $1 with ${2:-tests}.\n")

    async def read(_arguments) -> ToolResult:
        return ToolResult.text("unused")

    read_tool = AgentTool(
        name="read",
        label="read",
        description="read",
        input_schema={"type": "object"},
        execute=read,
    )
    provider = FakeProvider(
        [
            [{"type": "done", "stop_reason": "stop"}],
            [{"type": "done", "stop_reason": "stop"}],
        ]
    )
    runtime = AgentSession(
        provider=provider,
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry([read_tool]),
    )

    run(runtime.prompt("/fix parser"))
    run(runtime.prompt("/skill:explain focus on runtime"))

    assert provider.requests[0]["messages"][-1]["content"].strip() == "Fix parser with tests."
    assert '<skill name="explain"' in provider.requests[1]["messages"][-1]["content"]
    assert provider.requests[1]["messages"][-1]["content"].endswith("focus on runtime")
    assert "<available_skills>" in provider.requests[0]["systemPrompt"]
    assert "Current working directory:" in provider.requests[0]["systemPrompt"]


def test_reload_resources_finds_new_template(tmp_path: Path) -> None:
    runtime = AgentSession(
        provider=FakeProvider([]),
        model="fake",
        session_manager=SessionManager.in_memory(tmp_path),
        tool_registry=ToolRegistry(),
    )
    assert runtime.prompt_templates == ()

    _write(tmp_path / ".pi" / "prompts" / "new.md", "new prompt")
    resources = runtime.reload_resources()

    assert [template.name for template in resources.prompt_templates] == ["new"]

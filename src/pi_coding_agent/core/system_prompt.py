"""Coding-agent system prompt composition."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from pi_coding_agent.core.skills import Skill, format_skills_for_prompt

DEFAULT_SYSTEM_PROMPT = """You are an expert coding assistant. Help the user by reading files, executing commands, editing code, and writing files.

Guidelines:
- Work only inside the configured workspace unless the user explicitly expands scope.
- Be concise and show file paths clearly.
- Inspect existing code before changing it."""


def build_system_prompt(
    *,
    cwd: str | Path,
    selected_tools: Iterable[str],
    context_files: Iterable[tuple[Path, str]] = (),
    skills: Iterable[Skill] = (),
    custom_prompt: str | None = None,
    append_prompt: str | None = None,
) -> str:
    prompt = custom_prompt.strip() if custom_prompt and custom_prompt.strip() else DEFAULT_SYSTEM_PROMPT
    tool_names = tuple(selected_tools)
    if tool_names:
        prompt += "\n\nAvailable tools:\n" + "\n".join(f"- {name}" for name in tool_names)
    if append_prompt and append_prompt.strip():
        prompt += f"\n\n{append_prompt.strip()}"
    files = list(context_files)
    if files:
        prompt += "\n\n<project_context>\nProject-specific instructions and guidelines:\n\n"
        for path, content in files:
            prompt += f'<project_instructions path="{path}">\n{content.rstrip()}\n</project_instructions>\n\n'
        prompt += "</project_context>"
    if "read" in tool_names:
        prompt += format_skills_for_prompt(skills)
    return f"{prompt}\n\nCurrent working directory: {Path(cwd).resolve().as_posix()}"

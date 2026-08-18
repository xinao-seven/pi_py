"""Markdown prompt templates and slash-command expansion.

中文说明：Markdown 提示模板与斜杠命令展开：从 .pi/prompts 等目录加载
带 frontmatter 的模板，把 /模板名 参数 命令展开为模板内容。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import shlex
from typing import Iterable

from pi_coding_agent.core.frontmatter import parse_frontmatter


@dataclass(frozen=True, slots=True)
class PromptTemplate:
    """一个提示模板：名称、描述、正文、来源与参数提示。"""
    name: str
    description: str
    content: str
    file_path: Path
    source: str
    argument_hint: str | None = None


def load_prompt_templates(
    cwd: str | Path,
    *,
    agent_dir: str | Path | None = None,
    additional_paths: Iterable[str | Path] = (),
) -> tuple[PromptTemplate, ...]:
    """从用户级/项目级 prompts 目录加载模板（按名称去重）。"""
    root = Path(cwd).resolve()
    sources: list[tuple[Path, str]] = []
    if agent_dir is not None:
        sources.append((Path(agent_dir).resolve() / "prompts", "user"))
    sources.append((root / ".pi" / "prompts", "project"))
    sources.extend((Path(path).resolve(), "path") for path in additional_paths)
    by_name: dict[str, PromptTemplate] = {}
    for path, source in sources:
        files = (
            sorted(path.glob("*.md"), key=lambda item: item.name.casefold())
            if path.is_dir()
            else [path] if path.is_file() and path.suffix.lower() == ".md" else []
        )
        for file_path in files:
            template = _load_template(file_path.resolve(), source)
            if template is not None and template.name not in by_name:
                by_name[template.name] = template
    return tuple(by_name.values())


def expand_prompt_template(text: str, templates: Iterable[PromptTemplate]) -> str:
    """展开 /模板名 参数 命令；未知模板原样返回。"""
    match = re.fullmatch(r"/([^\s]+)(?:\s+([\s\S]*))?", text)
    if match is None:
        return text
    template = next((item for item in templates if item.name == match.group(1)), None)
    if template is None:
        return text
    try:
        arguments = shlex.split(match.group(2) or "", posix=True)
    except ValueError:
        arguments = (match.group(2) or "").split()
    return substitute_arguments(template.content, arguments)


def substitute_arguments(content: str, arguments: list[str]) -> str:
    """按模板里的占位符替换参数：
    ${1:-默认} 位置参数带默认值、${@:start[:len]} 切片、$ARGUMENTS/$@ 全部参数。"""
    all_arguments = " ".join(arguments)
    pattern = re.compile(
        r"\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)"
    )

    def replace(match: re.Match[str]) -> str:
        default_target, default, slice_start, slice_length, simple = match.groups()
        if default_target:
            value = (
                all_arguments
                if default_target in {"@", "ARGUMENTS"}
                else arguments[int(default_target) - 1] if int(default_target) <= len(arguments) else ""
            )
            return value or default
        if slice_start:
            start = max(0, int(slice_start) - 1)
            selected = arguments[start : start + int(slice_length)] if slice_length else arguments[start:]
            return " ".join(selected)
        if simple in {"@", "ARGUMENTS"}:
            return all_arguments
        index = int(simple) - 1
        return arguments[index] if 0 <= index < len(arguments) else ""

    return pattern.sub(replace, content)


def _load_template(path: Path, source: str) -> PromptTemplate | None:
    try:
        metadata, body = parse_frontmatter(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return None
    first_line = next((line.strip() for line in body.splitlines() if line.strip()), "")
    description = str(metadata.get("description") or first_line[:60])
    hint = metadata.get("argument-hint")
    return PromptTemplate(
        name=path.stem,
        description=description,
        content=body,
        file_path=path,
        source=source,
        argument_hint=str(hint) if hint else None,
    )

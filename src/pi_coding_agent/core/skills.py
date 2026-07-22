"""Agent Skills discovery, validation, and prompt formatting."""

from __future__ import annotations

from dataclasses import dataclass
from html import escape
from pathlib import Path
import re
from typing import Iterable

from pi_coding_agent.core.frontmatter import parse_frontmatter

MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024


@dataclass(frozen=True, slots=True)
class ResourceDiagnostic:
    type: str
    message: str
    path: Path


@dataclass(frozen=True, slots=True)
class Skill:
    name: str
    description: str
    file_path: Path
    base_dir: Path
    source: str
    disable_model_invocation: bool = False

    def read_body(self) -> str:
        _, body = parse_frontmatter(self.file_path.read_text(encoding="utf-8"))
        return body.strip()


@dataclass(frozen=True, slots=True)
class SkillsResult:
    skills: tuple[Skill, ...]
    diagnostics: tuple[ResourceDiagnostic, ...]


def load_skills(
    cwd: str | Path,
    *,
    agent_dir: str | Path | None = None,
    additional_paths: Iterable[str | Path] = (),
) -> SkillsResult:
    root = Path(cwd).resolve()
    sources: list[tuple[Path, str]] = []
    if agent_dir is not None:
        sources.append((Path(agent_dir).resolve() / "skills", "user"))
    sources.extend(
        [
            (root / ".pi" / "skills", "project"),
            (root / ".agents" / "skills", "project"),
        ]
    )
    sources.extend((Path(path).resolve(), "path") for path in additional_paths)
    by_name: dict[str, Skill] = {}
    seen_files: set[Path] = set()
    diagnostics: list[ResourceDiagnostic] = []
    for path, source in sources:
        for file_path in _discover_skill_files(path):
            canonical = file_path.resolve()
            if canonical in seen_files:
                continue
            seen_files.add(canonical)
            skill, file_diagnostics = _load_skill(canonical, source)
            diagnostics.extend(file_diagnostics)
            if skill is None:
                continue
            if skill.name in by_name:
                diagnostics.append(
                    ResourceDiagnostic(
                        "collision",
                        f'name "{skill.name}" collision; keeping {by_name[skill.name].file_path}',
                        skill.file_path,
                    )
                )
                continue
            by_name[skill.name] = skill
    return SkillsResult(tuple(by_name.values()), tuple(diagnostics))


def format_skills_for_prompt(skills: Iterable[Skill]) -> str:
    visible = [skill for skill in skills if not skill.disable_model_invocation]
    if not visible:
        return ""
    lines = [
        "",
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill file when the task matches its description.",
        "Resolve relative references against the directory containing SKILL.md.",
        "",
        "<available_skills>",
    ]
    for skill in visible:
        lines.extend(
            [
                "  <skill>",
                f"    <name>{escape(skill.name)}</name>",
                f"    <description>{escape(skill.description)}</description>",
                f"    <location>{escape(str(skill.file_path))}</location>",
                "  </skill>",
            ]
        )
    lines.append("</available_skills>")
    return "\n".join(lines)


def expand_skill_command(text: str, skills: Iterable[Skill]) -> str:
    if not text.startswith("/skill:"):
        return text
    command, _, arguments = text.partition(" ")
    name = command[7:]
    skill = next((item for item in skills if item.name == name), None)
    if skill is None:
        return text
    block = (
        f'<skill name="{skill.name}" location="{skill.file_path}">\n'
        f"References are relative to {skill.base_dir}.\n\n{skill.read_body()}\n</skill>"
    )
    return f"{block}\n\n{arguments.strip()}" if arguments.strip() else block


def _discover_skill_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() == ".md" else []
    if not path.is_dir():
        return []
    result: list[Path] = []
    stack = [path]
    while stack:
        directory = stack.pop()
        root_skill = directory / "SKILL.md"
        if root_skill.is_file():
            result.append(root_skill)
            continue
        for child in sorted(directory.iterdir(), key=lambda item: item.name.casefold(), reverse=True):
            if child.name.startswith(".") or child.name == "node_modules":
                continue
            if child.is_dir():
                stack.append(child)
            elif directory == path and child.suffix.lower() == ".md":
                result.append(child)
    return result


def _load_skill(path: Path, source: str) -> tuple[Skill | None, list[ResourceDiagnostic]]:
    diagnostics: list[ResourceDiagnostic] = []
    try:
        metadata, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError) as exception:
        return None, [ResourceDiagnostic("warning", str(exception), path)]
    description = str(metadata.get("description", "")).strip()
    name = str(metadata.get("name") or (path.parent.name if path.name == "SKILL.md" else path.stem))
    if not description:
        diagnostics.append(ResourceDiagnostic("warning", "description is required", path))
        return None, diagnostics
    if len(description) > MAX_DESCRIPTION_LENGTH:
        diagnostics.append(ResourceDiagnostic("warning", f"description exceeds {MAX_DESCRIPTION_LENGTH} characters", path))
    if len(name) > MAX_NAME_LENGTH:
        diagnostics.append(ResourceDiagnostic("warning", f"name exceeds {MAX_NAME_LENGTH} characters", path))
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        diagnostics.append(
            ResourceDiagnostic("warning", "name must use lowercase letters, digits, and single hyphens", path)
        )
    return (
        Skill(
            name=name,
            description=description,
            file_path=path,
            base_dir=path.parent,
            source=source,
            disable_model_invocation=metadata.get("disable-model-invocation") is True,
        ),
        diagnostics,
    )

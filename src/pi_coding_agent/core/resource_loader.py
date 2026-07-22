"""Project-local instructions, skills, prompts, and system prompt discovery."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from pi_coding_agent.core.prompt_templates import PromptTemplate, load_prompt_templates
from pi_coding_agent.core.skills import ResourceDiagnostic, Skill, load_skills

CONTEXT_NAMES = ("AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")


@dataclass(frozen=True, slots=True)
class CodingResources:
    context_files: tuple[tuple[Path, str], ...]
    skills: tuple[Skill, ...]
    prompt_templates: tuple[PromptTemplate, ...]
    diagnostics: tuple[ResourceDiagnostic, ...]
    system_prompt: str | None = None
    append_system_prompt: str | None = None


class CodingResourceLoader:
    def __init__(
        self,
        cwd: str | Path,
        *,
        agent_dir: str | Path | None = None,
        skill_paths: Iterable[str | Path] = (),
        prompt_paths: Iterable[str | Path] = (),
    ) -> None:
        self.cwd = Path(cwd).resolve()
        self.agent_dir = Path(agent_dir).resolve() if agent_dir is not None else None
        self.skill_paths = tuple(skill_paths)
        self.prompt_paths = tuple(prompt_paths)
        self._resources: CodingResources | None = None

    def load(self) -> CodingResources:
        skill_result = load_skills(
            self.cwd,
            agent_dir=self.agent_dir,
            additional_paths=self.skill_paths,
        )
        resources = CodingResources(
            context_files=tuple(self._load_context_files()),
            skills=skill_result.skills,
            prompt_templates=load_prompt_templates(
                self.cwd,
                agent_dir=self.agent_dir,
                additional_paths=self.prompt_paths,
            ),
            diagnostics=skill_result.diagnostics,
            system_prompt=self._read_preferred("SYSTEM.md"),
            append_system_prompt=self._read_preferred("APPEND_SYSTEM.md"),
        )
        self._resources = resources
        return resources

    def reload(self) -> CodingResources:
        return self.load()

    @property
    def resources(self) -> CodingResources:
        return self._resources or self.load()

    def _load_context_files(self) -> list[tuple[Path, str]]:
        found: list[tuple[Path, str]] = []
        seen: set[Path] = set()
        if self.agent_dir is not None:
            context = _context_file(self.agent_dir)
            if context:
                found.append(context)
                seen.add(context[0])
        ancestors = list(self.cwd.parents)
        ancestors.reverse()
        for directory in [*ancestors, self.cwd]:
            context = _context_file(directory)
            if context and context[0] not in seen:
                found.append(context)
                seen.add(context[0])
        return found

    def _read_preferred(self, name: str) -> str | None:
        project = self.cwd / ".pi" / name
        user = self.agent_dir / name if self.agent_dir is not None else None
        path = project if project.is_file() else user if user is not None and user.is_file() else None
        if path is None:
            return None
        try:
            return path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            return None


def _context_file(directory: Path) -> tuple[Path, str] | None:
    for name in CONTEXT_NAMES:
        path = directory / name
        if not path.is_file():
            continue
        try:
            return path.resolve(), path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
    return None

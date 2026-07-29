"""List and safely toggle local Agent Skills."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

from pi_coding_agent.core.skills import Skill, load_skills


class SkillService:
    def __init__(
        self,
        agent_dir: str | Path,
        workspace_roots_provider: Callable[[], Iterable[str | Path]],
    ) -> None:
        self.agent_dir = Path(agent_dir).expanduser().resolve()
        self._workspace_roots_provider = workspace_roots_provider

    def list(self, cwd: str | Path) -> dict[str, Any]:
        root = Path(cwd).expanduser().resolve()
        if _key(root) not in {_key(item) for item in self.workspace_roots()}:
            raise PermissionError("Workspace is not registered")
        result = load_skills(root, agent_dir=self.agent_dir)
        return {
            "skills": [_skill_dict(skill) for skill in result.skills],
            "diagnostics": [
                {
                    "type": diagnostic.type,
                    "message": diagnostic.message,
                    "path": str(diagnostic.path),
                }
                for diagnostic in result.diagnostics
            ],
        }

    def toggle(self, file_path: str | Path, disabled: bool) -> None:
        target = Path(file_path).expanduser().resolve()
        allowed = {
            skill.file_path.resolve()
            for root in self.workspace_roots()
            for skill in load_skills(root, agent_dir=self.agent_dir).skills
        }
        if target not in allowed:
            raise PermissionError("Skill file is not part of a registered workspace")
        if not target.is_file():
            raise FileNotFoundError(target)
        content = target.read_text(encoding="utf-8")
        key = "disable-model-invocation"
        line_pattern = re.compile(rf"^{re.escape(key)}\s*:.*(?:\r?\n|$)", re.MULTILINE)
        if disabled:
            if line_pattern.search(content):
                updated = line_pattern.sub(f"{key}: true\n", content, count=1)
            elif content.startswith("---\n") or content.startswith("---\r\n"):
                updated = re.sub(r"^---\r?\n", f"---\n{key}: true\n", content, count=1)
            else:
                updated = f"---\n{key}: true\n---\n{content}"
        else:
            updated = line_pattern.sub("", content, count=1)
        if updated == content:
            return
        temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
        temporary.write_text(updated, encoding="utf-8", newline="\n")
        temporary.replace(target)

    def workspace_roots(self) -> tuple[Path, ...]:
        return tuple(Path(item).expanduser().resolve() for item in self._workspace_roots_provider())


def _skill_dict(skill: Skill) -> dict[str, Any]:
    return {
        "name": skill.name,
        "description": skill.description,
        "filePath": str(skill.file_path),
        "baseDir": str(skill.base_dir),
        "source": skill.source,
        "sourceInfo": {
            "source": skill.source,
            "scope": "project" if skill.source == "project" else "user",
            "path": str(skill.file_path),
            "baseDir": str(skill.base_dir),
        },
        "disableModelInvocation": skill.disable_model_invocation,
    }


def _key(path: Path) -> str:
    return str(path).casefold()

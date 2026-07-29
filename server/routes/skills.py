"""Local Skill discovery and model-invocation toggle routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from server.errors import APIError
from server.services.agent_registry import AgentRegistry
from server.services.skill_service import SkillService

router = APIRouter(prefix="/api/skills", tags=["skills"])


class ToggleSkillRequest(BaseModel):
    filePath: str
    disableModelInvocation: bool


def get_skill_service(request: Request) -> SkillService:
    return request.app.state.skill_service


def get_registry(request: Request) -> AgentRegistry:
    return request.app.state.agent_registry


@router.get("")
async def list_skills(cwd: str, service: SkillService = Depends(get_skill_service)) -> dict:
    try:
        return service.list(cwd)
    except PermissionError as exception:
        raise APIError(403, "workspace_not_allowed", str(exception)) from exception


@router.patch("")
async def toggle_skill(
    body: ToggleSkillRequest,
    service: SkillService = Depends(get_skill_service),
    registry: AgentRegistry = Depends(get_registry),
) -> dict[str, bool]:
    try:
        service.toggle(body.filePath, body.disableModelInvocation)
    except PermissionError as exception:
        raise APIError(403, "skill_not_allowed", str(exception)) from exception
    except FileNotFoundError as exception:
        raise APIError(404, "skill_not_found", str(exception)) from exception
    for entry in registry.entries():
        entry.agent.reload_resources()
    return {"success": True}

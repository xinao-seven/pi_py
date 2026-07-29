"""Safe local workspace alternatives to a native folder picker."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from server.errors import APIError
from server.services.workspace_service import WorkspaceService

router = APIRouter(tags=["workspaces"])


class SelectWorkspaceRequest(BaseModel):
    cwd: str


def get_workspace_service(request: Request) -> WorkspaceService:
    return request.app.state.workspace_service


@router.get("/api/home")
async def get_home(service: WorkspaceService = Depends(get_workspace_service)) -> dict[str, str]:
    return {"home": str(service.workspace_parent)}


@router.get("/api/workspaces")
async def list_workspaces(service: WorkspaceService = Depends(get_workspace_service)) -> dict:
    return {"workspaces": [str(root) for root in service.roots()]}


@router.post("/api/default-cwd")
async def create_default_workspace(
    service: WorkspaceService = Depends(get_workspace_service),
) -> dict[str, str]:
    try:
        return {"cwd": str(service.create_default())}
    except OSError as exception:
        raise APIError(500, "workspace_create_failed", str(exception)) from exception


@router.post("/api/workspaces/select")
async def select_workspace(
    body: SelectWorkspaceRequest,
    service: WorkspaceService = Depends(get_workspace_service),
) -> dict[str, str]:
    try:
        return {"cwd": str(service.select(body.cwd))}
    except ValueError as exception:
        raise APIError(400, "invalid_workspace", str(exception)) from exception
    except PermissionError as exception:
        raise APIError(403, "workspace_not_allowed", str(exception)) from exception

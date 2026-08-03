"""Safe local workspace alternatives to a native folder picker.

中文说明：工作区 API：获取主目录、列出已登记工作区、创建默认工作区，
以及安全地登记用户输入的工作区路径（替代原生文件夹选择器）。
"""

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
    """返回受控工作区父目录。"""
    return {"home": str(service.workspace_parent)}


@router.get("/api/workspaces")
async def list_workspaces(service: WorkspaceService = Depends(get_workspace_service)) -> dict:
    """列出当前允许的所有工作区根目录。"""
    return {"workspaces": [str(root) for root in service.roots()]}


@router.post("/api/default-cwd")
async def create_default_workspace(
    service: WorkspaceService = Depends(get_workspace_service),
) -> dict[str, str]:
    """在受控父目录下创建默认工作区（pi-cwd-日期）。"""
    try:
        return {"cwd": str(service.create_default())}
    except OSError as exception:
        raise APIError(500, "workspace_create_failed", str(exception)) from exception


@router.post("/api/workspaces/select")
async def select_workspace(
    body: SelectWorkspaceRequest,
    service: WorkspaceService = Depends(get_workspace_service),
) -> dict[str, str]:
    """登记一个已有目录为工作区；必须位于父目录或已登记工作区之下。"""
    try:
        return {"cwd": str(service.select(body.cwd))}
    except ValueError as exception:
        raise APIError(400, "invalid_workspace", str(exception)) from exception
    except PermissionError as exception:
        raise APIError(403, "workspace_not_allowed", str(exception)) from exception

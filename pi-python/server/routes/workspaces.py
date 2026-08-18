"""Local workspace registration and native folder picker routes.

中文说明：工作区 API：获取主目录、列出已登记工作区、创建默认工作区，
以及登记用户输入或系统选择器返回的已有本地目录。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from server.errors import APIError
from server.services.directory_picker import choose_directory
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


@router.post("/api/workspaces/pick")
async def pick_workspace(
    service: WorkspaceService = Depends(get_workspace_service),
) -> dict[str, str | None]:
    """Open a native folder picker after the user clicks the Web UI action."""
    try:
        selected = await run_in_threadpool(choose_directory)
    except RuntimeError as exception:
        raise APIError(503, "directory_picker_unavailable", str(exception)) from exception
    if selected is None:
        return {"cwd": None}
    try:
        return {"cwd": str(service.select(selected))}
    except ValueError as exception:
        raise APIError(400, "invalid_workspace", str(exception)) from exception


@router.post("/api/workspaces/select")
async def select_workspace(
    body: SelectWorkspaceRequest,
    service: WorkspaceService = Depends(get_workspace_service),
) -> dict[str, str]:
    """登记一个已有本地目录为工作区。"""
    try:
        return {"cwd": str(service.select(body.cwd))}
    except ValueError as exception:
        raise APIError(400, "invalid_workspace", str(exception)) from exception

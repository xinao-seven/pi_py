"""Workspace file list, preview, media, and watch routes.

中文说明：Files API：工作区目录浏览、文本/图片/音频预览与文件变化 SSE 监听。
所有路径经 FileService 做工作区边界与敏感文件检查。
"""

from __future__ import annotations

import mimetypes
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse, StreamingResponse

from server.errors import APIError
from server.services.file_service import FileAccessError, FileService

router = APIRouter(prefix="/api/files", tags=["files"])


def get_file_service(request: Request) -> FileService:
    return request.app.state.file_service


@router.get("/{file_path:path}")
async def access_file(
    file_path: str,
    root: str,
    preview_type: Annotated[
        Literal["list", "read", "media", "watch"],
        Query(alias="type"),
    ] = "list",
    service: FileService = Depends(get_file_service),
):
    """按 type 参数分发：list 列目录、read 读文本/媒体、media 返回媒体、watch SSE 监听。"""
    try:
        if preview_type == "list":
            return service.list_directory(file_path, root)
        if preview_type == "read":
            mime = mimetypes.guess_type(file_path)[0] or ""
            if mime.startswith("image/") or mime.startswith("audio/"):
                target, media_type = service.media_file(file_path, root)
                return FileResponse(target, media_type=media_type)
            return service.read_text(file_path, root)
        if preview_type == "media":
            target, media_type = service.media_file(file_path, root)
            return FileResponse(target, media_type=media_type)
        return StreamingResponse(
            service.watch(file_path, root),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )
    except FileAccessError as exception:
        raise APIError(
            exception.status_code,
            exception.code,
            exception.message,
        ) from exception

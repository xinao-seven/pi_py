"""Workspace file list, preview, media, and watch routes."""

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

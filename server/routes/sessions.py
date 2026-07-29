"""Persistent Session browsing and metadata routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator

from server.errors import APIError
from server.services.session_store import SessionStore, session_detail, session_info_to_dict

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class RenameSessionRequest(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=200)]

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Session name must not be blank")
        return normalized


def get_session_store(request: Request) -> SessionStore:
    return request.app.state.session_store


@router.get("")
async def list_sessions(store: SessionStore = Depends(get_session_store)) -> dict:
    return {"sessions": [session_info_to_dict(info) for info in store.list()]}


@router.get("/{session_id}")
async def get_session(session_id: str, store: SessionStore = Depends(get_session_store)) -> dict:
    info = store.find(session_id)
    if info is None:
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    manager = store.open(session_id)
    if manager is None:  # The file may have disappeared between discovery and opening.
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    return session_detail(manager, info)


@router.get("/{session_id}/context")
async def get_session_context(
    session_id: str,
    leaf_id: str | None = None,
    store: SessionStore = Depends(get_session_store),
) -> dict:
    manager = store.open(session_id)
    if manager is None:
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    if leaf_id is not None:
        try:
            manager.branch(leaf_id)
        except KeyError as exception:
            raise APIError(
                404,
                "entry_not_found",
                f"Entry {leaf_id!r} was not found in Session {session_id!r}",
            ) from exception
    return manager.build_web_session_context()


@router.patch("/{session_id}")
async def rename_session(
    session_id: str,
    body: RenameSessionRequest,
    store: SessionStore = Depends(get_session_store),
) -> dict[str, bool]:
    manager = store.open(session_id)
    if manager is None:
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    manager.append_session_info(body.name)
    return {"ok": True}

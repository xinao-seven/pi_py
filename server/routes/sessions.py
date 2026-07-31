"""Persistent Session browsing and metadata routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator

from server.errors import APIError
from server.services.agent_registry import AgentRegistry
from server.services.session_merge import append_merge_summary, create_session_merge_summary
from server.services.session_store import (
    SessionStore,
    session_detail,
    session_info_list_to_dict,
)

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


class MergeSessionRequest(BaseModel):
    sourceSessionId: str


class ForkSessionRequest(BaseModel):
    leafId: Annotated[str, Field(min_length=1)]


def get_session_store(request: Request) -> SessionStore:
    return request.app.state.session_store


def get_agent_registry(request: Request) -> AgentRegistry:
    return request.app.state.agent_registry


@router.get("")
async def list_sessions(store: SessionStore = Depends(get_session_store)) -> dict:
    return {"sessions": session_info_list_to_dict(store.list())}


@router.get("/{session_id}")
async def get_session(session_id: str, store: SessionStore = Depends(get_session_store)) -> dict:
    info = store.find(session_id)
    if info is None:
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    manager = store.open(session_id)
    if manager is None:  # The file may have disappeared between discovery and opening.
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    serialized = session_info_list_to_dict(store.list())
    parent_session_id = next(
        (item["parentSessionId"] for item in serialized if item["id"] == session_id),
        None,
    )
    return session_detail(manager, info, parent_session_id=parent_session_id)


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


@router.delete("/{session_id}")
async def delete_session(
    session_id: str,
    store: SessionStore = Depends(get_session_store),
    registry: AgentRegistry = Depends(get_agent_registry),
) -> dict:
    if store.find(session_id) is None:
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    await registry.remove(session_id)
    try:
        reparented = store.delete_with_reparent(session_id)
    except OSError as exception:
        raise APIError(500, "session_delete_failed", str(exception)) from exception
    if reparented is None:
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    return {"ok": True, "reparentedCount": reparented}


@router.post("/{session_id}/fork")
async def fork_session(
    session_id: str,
    body: ForkSessionRequest,
    store: SessionStore = Depends(get_session_store),
) -> dict:
    source = store.open(session_id)
    if source is None:
        raise APIError(404, "session_not_found", f"Session {session_id!r} was not found")
    try:
        new_path = source.create_branched_session(body.leafId)
    except KeyError as exception:
        raise APIError(
            404,
            "entry_not_found",
            f"Entry {body.leafId!r} was not found in Session {session_id!r}",
        ) from exception
    if new_path is None or not new_path.exists():
        raise APIError(
            409,
            "fork_not_persisted",
            "The selected branch has no assistant response and cannot be persisted",
        )
    info = store.find(source.session_id)
    if info is None:
        raise APIError(500, "session_fork_failed", "The forked Session could not be discovered")
    serialized = session_info_list_to_dict(store.list())
    forked_info = next(item for item in serialized if item["id"] == source.session_id)
    return {"ok": True, "sessionId": source.session_id, "info": forked_info}


@router.post("/{session_id}/merge")
async def merge_session(
    session_id: str,
    body: MergeSessionRequest,
    store: SessionStore = Depends(get_session_store),
    registry: AgentRegistry = Depends(get_agent_registry),
) -> dict:
    if body.sourceSessionId == session_id:
        raise APIError(400, "invalid_merge", "A Session cannot be merged into itself")
    target_info = store.find(session_id)
    source = store.open(body.sourceSessionId)
    if target_info is None:
        raise APIError(404, "session_not_found", f"Target Session {session_id!r} was not found")
    if source is None:
        raise APIError(
            404,
            "session_not_found",
            f"Source Session {body.sourceSessionId!r} was not found",
        )
    live_target = registry.get(session_id)
    target = live_target.agent.session_manager if live_target is not None else store.open(session_id)
    if target is None:
        raise APIError(404, "session_not_found", f"Target Session {session_id!r} was not found")
    summary = create_session_merge_summary(source, target)
    if summary is None:
        raise APIError(409, "nothing_to_merge", "Source Session has no new mergeable content")
    entry_id = append_merge_summary(target, body.sourceSessionId, summary)
    if live_target is not None:
        live_target.agent.messages = target.build_session_context()["messages"]
    return {
        "ok": True,
        "entryId": entry_id,
        "sourceUniqueEntryCount": summary.source_unique_entry_count,
        "summarizedItemCount": summary.summarized_item_count,
    }

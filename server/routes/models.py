"""Model catalog and credential-safe models.json routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request

from server.config import ServerSettings
from server.errors import APIError
from server.services.model_config import ModelConfigService

router = APIRouter(tags=["models"])


def get_model_config(request: Request) -> ModelConfigService:
    return request.app.state.model_config


def get_settings(request: Request) -> ServerSettings:
    return request.app.state.settings


@router.get("/api/models-config")
async def read_models_config(service: ModelConfigService = Depends(get_model_config)) -> dict:
    return service.read()


@router.put("/api/models-config")
async def write_models_config(
    body: dict[str, Any],
    service: ModelConfigService = Depends(get_model_config),
) -> dict[str, bool]:
    try:
        service.write(body)
    except ValueError as exception:
        raise APIError(422, "invalid_models_config", str(exception)) from exception
    return {"success": True}


@router.get("/api/models")
async def list_models(
    service: ModelConfigService = Depends(get_model_config),
    settings: ServerSettings = Depends(get_settings),
) -> dict:
    return service.catalog(
        default_provider=settings.default_provider,
        default_model=settings.default_model,
    )

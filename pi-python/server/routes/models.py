"""Model catalog and credential-safe models.json routes.

中文说明：模型配置 API：读写 models.json（只允许 $ENV_VAR 密钥引用），
以及汇总模型目录、默认模型与思考档位能力的 catalog。
"""

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
    """读取当前 models.json 配置（不含真实密钥）。"""
    return service.read()


@router.put("/api/models-config")
async def write_models_config(
    body: dict[str, Any],
    service: ModelConfigService = Depends(get_model_config),
) -> dict[str, bool]:
    """校验并原子写入 models.json。"""
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
    """汇总模型目录：可用模型、默认模型、各模型支持的思考档位。"""
    return service.catalog(
        default_provider=settings.default_provider,
        default_model=settings.default_model,
    )

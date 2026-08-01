"""FastAPI application factory and Uvicorn entry point."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from server.config import ServerSettings
from server.errors import install_error_handlers
from server.routes import agent, files, health, models, sessions, skills, workspaces
from server.services.agent_registry import AgentRegistry, ProviderResolver
from server.services.file_service import FileService
from server.services.model_config import ModelConfigService
from server.services.skill_service import SkillService
from server.services.workspace_service import WorkspaceService
from server.services.session_store import SessionStore


def create_app(
    settings: ServerSettings | None = None,
    *,
    provider_resolver: ProviderResolver | None = None,
) -> FastAPI:
    resolved = settings or ServerSettings.from_env()
    store = SessionStore(resolved.sessions_dir)
    model_config = ModelConfigService(
        resolved.agent_dir,
        secrets_file=resolved.secrets_file or resolved.agent_dir / "secrets.env",
    )
    registry_kwargs = {
        "provider_resolver": provider_resolver or model_config.resolve_provider,
        "model_resolver": model_config.resolve_model,
        "agent_dir": resolved.agent_dir,
    }
    registry = AgentRegistry(
        store,
        idle_timeout=resolved.idle_timeout_seconds,
        **registry_kwargs,
    )
    workspace_service = WorkspaceService(
        resolved.workspace_parent,
        lambda: [
            *(info.cwd for info in store.list() if info.cwd),
            *registry.workspace_roots(),
        ],
    )
    skill_service = SkillService(resolved.agent_dir, workspace_service.roots)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        del application
        yield
        await registry.close()

    app = FastAPI(
        title="Pi Agent Python Server",
        version="0.1.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    app.state.settings = resolved
    app.state.session_store = store
    app.state.agent_registry = registry
    app.state.model_config = model_config
    app.state.workspace_service = workspace_service
    app.state.skill_service = skill_service
    app.state.file_service = FileService(
        workspace_service.roots
    )
    if resolved.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(resolved.cors_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(sessions.router)
    app.include_router(agent.router)
    app.include_router(files.router)
    app.include_router(models.router)
    app.include_router(workspaces.router)
    app.include_router(skills.router)
    if resolved.web_dist_dir is not None and resolved.web_dist_dir.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=resolved.web_dist_dir, html=True),
            name="web",
        )
    return app


app = create_app()

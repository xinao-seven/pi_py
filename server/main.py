"""FastAPI application factory and Uvicorn entry point."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.config import ServerSettings
from server.errors import install_error_handlers
from server.routes import agent, health, sessions
from server.services.agent_registry import AgentRegistry, ProviderResolver
from server.services.session_store import SessionStore


def create_app(
    settings: ServerSettings | None = None,
    *,
    provider_resolver: ProviderResolver | None = None,
) -> FastAPI:
    resolved = settings or ServerSettings.from_env()
    store = SessionStore(resolved.sessions_dir)
    registry_kwargs = {"provider_resolver": provider_resolver} if provider_resolver else {}
    registry = AgentRegistry(
        store,
        idle_timeout=resolved.idle_timeout_seconds,
        **registry_kwargs,
    )

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
    return app


app = create_app()

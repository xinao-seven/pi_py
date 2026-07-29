"""FastAPI application factory and Uvicorn entry point."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.config import ServerSettings
from server.errors import install_error_handlers
from server.routes import health, sessions
from server.services.session_store import SessionStore


def create_app(settings: ServerSettings | None = None) -> FastAPI:
    resolved = settings or ServerSettings.from_env()
    app = FastAPI(
        title="Pi Agent Python Server",
        version="0.1.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.state.settings = resolved
    app.state.session_store = SessionStore(resolved.sessions_dir)
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
    return app


app = create_app()

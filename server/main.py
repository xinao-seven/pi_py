"""FastAPI application factory and Uvicorn entry point.

中文说明：应用工厂：组装依赖（SessionStore、AgentRegistry、模型配置、
工作区/文件/技能服务），注册路由与中间件，可选挂载 Vue 静态前端。
"""

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
    """创建 FastAPI 应用：依赖装配、路由注册与静态托管。
    provider_resolver 可注入，测试用它替换真实 Provider 实现。"""
    resolved = settings or ServerSettings.from_env()
    # 会话存储：负责发现/打开持久化 Session 文件
    store = SessionStore(resolved.sessions_dir)
    # 模型配置：读写 models.json，并把 apiKey 变量引用解析为真实密钥
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
        # 已知工作区根：历史会话 cwd + 活跃 Agent 的 cwd + 用户手动选择
        resolved.workspace_parent,
        lambda: [
            *(info.cwd for info in store.list() if info.cwd),
            *registry.workspace_roots(),
        ],
    )
    skill_service = SkillService(resolved.agent_dir, workspace_service.roots)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        # 应用关闭时清理全部活跃 Agent（取消任务、解除订阅）
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
    # 把装配好的服务挂到 app.state，路由用 Depends 取用
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
        # 生产模式：API 路由之后挂载 Vue 静态文件（同源托管）
        app.mount(
            "/",
            StaticFiles(directory=resolved.web_dist_dir, html=True),
            name="web",
        )
    return app


app = create_app()

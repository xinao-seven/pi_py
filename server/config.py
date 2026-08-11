"""Server configuration with pi-first defaults.

中文说明：服务配置（目录、CORS、超时、默认模型等）。默认值全部指向原版 pi
在 ~/.pi/agent 下的真实配置位置；pi 的默认 Provider/模型/思考档位在应用
组装时从 settings.json 读取（见 main.py），这里只保留纯部署相关且 pi 中
没有对应项的覆盖变量（会话目录、CORS、超时、静态前端目录等）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path


@dataclass(frozen=True, slots=True)
class ServerSettings:
    """服务配置集合：agent 目录、pi.py 自身配置目录、会话目录、CORS、超时与静态前端目录。"""
    # 原版 pi 的配置目录（auth.json / settings.json / models.json 都在这里）
    agent_dir: Path = field(default_factory=lambda: Path.home() / ".pi" / "agent")
    # pi.py 自身的可写配置目录：Web 编辑器改写的模型覆盖、工作区登记等
    # 与原版 pi 的 ~/.pi/agent 完全隔离，不会污染 pi 的配置
    own_config_dir: Path = field(
        default_factory=lambda: Path.home() / ".pi" / "agent-python"
    )
    # 原版 pi 的会话目录（按工作区组织，pi.py 复用同一目录）
    sessions_dir: Path = field(
        default_factory=lambda: Path.home() / ".pi" / "agent" / "sessions"
    )
    workspace_parent: Path = field(default_factory=Path.home)
    cors_origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173")
    idle_timeout_seconds: float = 600
    sse_heartbeat_seconds: float = 30
    # 仅作为 settings.json 缺失时的回退；存在时由 main.py 用 pi 的设置覆盖
    default_provider: str = "anthropic"
    default_model: str = "claude-sonnet-4-6"
    default_thinking_level: str = "off"
    web_dist_dir: Path | None = field(
        default_factory=lambda: Path(__file__).resolve().parents[1] / "web" / "dist"
    )

    @classmethod
    def from_env(cls) -> ServerSettings:
        """从环境变量构造纯部署覆盖项；未设置的项使用默认值。

        中文说明：这里不解析任何密钥或 pi 的设置（defaultProvider 等），
        那些一律来自原版 pi 的 ~/.pi/agent 配置。"""
        agent_dir = Path(
            os.getenv("PI_SERVER_AGENT_DIR", str(Path.home() / ".pi" / "agent"))
        ).expanduser()
        origins = tuple(
            origin.strip()
            for origin in os.getenv(
                "PI_SERVER_CORS_ORIGINS",
                "http://127.0.0.1:5173,http://localhost:5173",
            ).split(",")
            if origin.strip()
        )
        web_dist_value = os.getenv("PI_SERVER_WEB_DIST")
        return cls(
            agent_dir=agent_dir,
            # pi.py 自身配置始终与 pi 的 agent 目录平级隔离
            own_config_dir=agent_dir.parent / "agent-python",
            sessions_dir=Path(
                os.getenv(
                    "PI_SERVER_SESSIONS_DIR",
                    str(agent_dir / "sessions"),
                )
            ).expanduser(),
            cors_origins=origins,
            idle_timeout_seconds=float(os.getenv("PI_SERVER_IDLE_TIMEOUT", "600")),
            sse_heartbeat_seconds=float(os.getenv("PI_SERVER_SSE_HEARTBEAT", "30")),
            web_dist_dir=(
                Path(web_dist_value).expanduser()
                if web_dist_value
                else (
                    None
                    if web_dist_value == ""
                    else Path(__file__).resolve().parents[1] / "web" / "dist"
                )
            ),
        )

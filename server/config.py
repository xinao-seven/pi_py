"""Environment-backed server configuration."""

from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path


@dataclass(frozen=True, slots=True)
class ServerSettings:
    sessions_dir: Path = field(
        default_factory=lambda: Path.home() / ".pi" / "agent" / "sessions"
    )
    cors_origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173")
    idle_timeout_seconds: float = 600
    sse_heartbeat_seconds: float = 30
    default_provider: str = "anthropic"
    default_model: str = "claude-sonnet-4-6"

    @classmethod
    def from_env(cls) -> ServerSettings:
        origins = tuple(
            origin.strip()
            for origin in os.getenv(
                "PI_SERVER_CORS_ORIGINS",
                "http://127.0.0.1:5173,http://localhost:5173",
            ).split(",")
            if origin.strip()
        )
        return cls(
            sessions_dir=Path(
                os.getenv(
                    "PI_SERVER_SESSIONS_DIR",
                    str(Path.home() / ".pi" / "agent" / "sessions"),
                )
            ).expanduser(),
            cors_origins=origins,
            idle_timeout_seconds=float(os.getenv("PI_SERVER_IDLE_TIMEOUT", "600")),
            sse_heartbeat_seconds=float(os.getenv("PI_SERVER_SSE_HEARTBEAT", "30")),
            default_provider=os.getenv("PI_SERVER_DEFAULT_PROVIDER", "anthropic"),
            default_model=os.getenv("PI_SERVER_DEFAULT_MODEL", "claude-sonnet-4-6"),
        )

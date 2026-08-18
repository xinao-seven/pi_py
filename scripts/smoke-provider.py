"""Run one explicit, low-cost real Provider request without printing credentials."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PYTHON_PROJECT = PROJECT_ROOT / "pi-python"
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PYTHON_PROJECT))
sys.path.insert(0, str(PYTHON_PROJECT / "src"))

from server.config import ServerSettings  # noqa: E402
from server.services.agent_registry import ProviderConfigurationError  # noqa: E402
from server.services.model_config import ModelConfigService  # noqa: E402
from server.services.pi_config import PiConfig  # noqa: E402


async def run() -> int:
    # 脚本自身的 smoke 参数（不是 pi 的密钥/设置）；密钥只来自 auth.json
    provider_name = os.getenv("PI_SMOKE_PROVIDER", "anthropic").strip()
    model = os.getenv("PI_SMOKE_MODEL", "claude-sonnet-4-6").strip()
    prompt = os.getenv(
        "PI_SMOKE_PROMPT",
        "Reply with exactly: pi provider smoke ok",
    ).strip()
    settings = ServerSettings.from_env()
    print(f"Provider smoke: provider={provider_name}, model={model}")
    print("This performs one real API request and may incur a small charge.")
    pi_config = PiConfig(settings.agent_dir)
    try:
        provider = ModelConfigService(
            pi_config,
            settings.own_config_dir,
        ).resolve_provider(provider_name)
    except ProviderConfigurationError as exception:
        print(f"Configuration error: {exception}", file=sys.stderr)
        print(
            "Store the key in the original pi's ~/.pi/agent/auth.json "
            "(e.g. via /login in pi); do not paste it into models.json.",
            file=sys.stderr,
        )
        return 2

    text_parts: list[str] = []
    error: str | None = None
    async for event in provider.stream(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        tools=[],
        thinking_level="off",
        system_prompt="You are a connectivity smoke test. Follow the user instruction exactly.",
    ):
        if event.get("type") == "text_delta":
            text_parts.append(str(event.get("text", "")))
        elif event.get("type") == "done" and event.get("error"):
            error = str(event["error"])
    if error:
        print(f"Provider error: {error}", file=sys.stderr)
        return 1
    response = "".join(text_parts).strip()
    print(f"Response: {response[:500] or '[empty]'}")
    return 0 if response else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))

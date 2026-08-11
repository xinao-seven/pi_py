"""Read-only access to the original pi's user configuration.

中文说明：只读访问原版 pi 放在 ~/.pi/agent 下的用户配置：

- auth.json        原版 pi 的 API Key（/login 写入），本服务据此解析密钥；
- settings.json    默认 Provider / 模型 / 思考档位等设置；
- models.json      用户自定义 Provider / 模型覆盖（只读，绝不写回）；
- models-store.json 原版 pi 自动缓存的内置模型目录（只读）。

本服务严格只读：缺失或损坏的文件一律返回空值，绝不创建或改写任何文件，
避免影响原版 pi 的运行。密钥解析只查 auth.json，不读取进程环境变量。
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

MAX_AUTH_BYTES = 512 * 1024
MAX_SETTINGS_BYTES = 512 * 1024
MAX_MODELS_BYTES = 512 * 1024
MAX_MODELS_STORE_BYTES = 16 * 1024 * 1024

# models.json 里 $ENV_VAR 引用（环境变量名）→ auth.json 中的 key 名。
# 只覆盖本项目内置 Provider 会用到的常用映射；未知名称会按字面量在
# auth.json 中查找（原版 pi 的 /login 也可以写入任意自定义 key 名）。
ENV_TO_AUTH_KEY = {
    "ANTHROPIC_API_KEY": "anthropic",
    "OPENAI_API_KEY": "openai",
    "DEEPSEEK_API_KEY": "deepseek",
    "GEMINI_API_KEY": "google",
    "OPENROUTER_API_KEY": "openrouter",
    "XAI_API_KEY": "xai",
    "HF_TOKEN": "huggingface",
    "KIMI_API_KEY": "kimi-coding",
    "FIREWORKS_API_KEY": "fireworks",
    "TOGETHER_API_KEY": "together",
    "MISTRAL_API_KEY": "mistral",
    "GROQ_API_KEY": "groq",
    "CEREBRAS_API_KEY": "cerebras",
    "NVIDIA_API_KEY": "nvidia",
    "MINIMAX_API_KEY": "minimax",
    "MINIMAX_CN_API_KEY": "minimax-cn",
    "QWEN_TOKEN_PLAN_API_KEY": "qwen-token-plan",
    "QWEN_TOKEN_PLAN_CN_API_KEY": "qwen-token-plan-cn",
    "XIAOMI_API_KEY": "xiaomi",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY": "xiaomi-token-plan-cn",
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY": "xiaomi-token-plan-ams",
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY": "xiaomi-token-plan-sgp",
}

# 内置 Provider 名称 → auth.json 中的 key 名。
PROVIDER_TO_AUTH_KEY = {
    "anthropic": "anthropic",
    "openai": "openai",
    "openai-compatible": "openai",
    "deepseek": "deepseek",
    "google": "google",
    "openrouter": "openrouter",
    "xai": "xai",
    "huggingface": "huggingface",
    "kimi-coding": "kimi-coding",
    "fireworks": "fireworks",
    "together": "together",
    "mistral": "mistral",
    "groq": "groq",
    "cerebras": "cerebras",
    "nvidia": "nvidia",
    "minimax": "minimax",
    "minimax-cn": "minimax-cn",
    "qwen-token-plan": "qwen-token-plan",
    "qwen-token-plan-cn": "qwen-token-plan-cn",
    "xiaomi": "xiaomi",
    "xiaomi-token-plan-cn": "xiaomi-token-plan-cn",
    "xiaomi-token-plan-ams": "xiaomi-token-plan-ams",
    "xiaomi-token-plan-sgp": "xiaomi-token-plan-sgp",
}


@dataclass(frozen=True, slots=True)
class PiUserSettings:
    """原版 pi settings.json 中的关键设置（只读视图）。"""
    default_provider: str | None = None
    default_model: str | None = None
    default_thinking_level: str | None = None
    theme: str | None = None


class PiConfigError(ValueError):
    """pi 配置文件无法读取（超限或 IO 失败）时抛出。

    中文说明：JSON 格式错误按“缺失”处理返回空值，只有 IO/体积异常才抛错，
    避免个别文件损坏导致整个服务不可用。
    """


class PiConfig:
    """原版 pi 用户配置的只读访问器；任何写操作都不属于本服务。"""
    def __init__(self, agent_dir: str | Path) -> None:
        self.agent_dir = Path(agent_dir).expanduser().resolve()
        self.auth_path = self.agent_dir / "auth.json"
        self.settings_path = self.agent_dir / "settings.json"
        self.models_path = self.agent_dir / "models.json"
        self.models_store_path = self.agent_dir / "models-store.json"

    # ---- auth.json：API Key ----

    def read_auth(self) -> dict[str, dict[str, Any]]:
        """读取 auth.json，返回 {key名: 凭据对象}；缺失/损坏时返回空 dict。"""
        value = self._read_json(self.auth_path, MAX_AUTH_BYTES)
        if not isinstance(value, dict):
            return {}
        return {
            str(name): entry
            for name, entry in value.items()
            if isinstance(entry, dict)
        }

    def resolve_api_key(self, name: str) -> str | None:
        """按名称解析 API Key：name 可以是内置 Provider 名（deepseek）、
        models.json 里的 $ENV_VAR 引用（DEEPSEEK_API_KEY）或 auth.json 中
        的任意 key 名。只查 auth.json，绝不读取进程环境变量。"""
        key_name = (
            PROVIDER_TO_AUTH_KEY.get(name)
            or ENV_TO_AUTH_KEY.get(name)
            or _heuristic_auth_key(name)
        )
        entry = self.read_auth().get(key_name)
        if not isinstance(entry, dict):
            return None
        key = entry.get("key")
        return key if isinstance(key, str) and key else None

    # ---- settings.json：默认设置 ----

    def read_settings(self) -> PiUserSettings:
        """读取 settings.json 中的默认 Provider/模型/思考档位/主题。"""
        value = self._read_json(self.settings_path, MAX_SETTINGS_BYTES)
        if not isinstance(value, dict):
            return PiUserSettings()
        return PiUserSettings(
            default_provider=_optional_string(value, "defaultProvider"),
            default_model=_optional_string(value, "defaultModel"),
            default_thinking_level=_optional_string(value, "defaultThinkingLevel"),
            theme=_optional_string(value, "theme"),
        )

    # ---- models.json / models-store.json：模型目录（只读） ----

    def read_models(self) -> dict[str, Any]:
        """读取 models.json 用户自定义覆盖；返回 {"providers": {...}}。"""
        value = self._read_json(self.models_path, MAX_MODELS_BYTES)
        if isinstance(value, dict) and isinstance(value.get("providers"), dict):
            return value
        return {"providers": {}}

    def read_models_store(self) -> dict[str, Any]:
        """读取 models-store.json 缓存目录；返回 {Provider名: {models: [...]}}。"""
        value = self._read_json(self.models_store_path, MAX_MODELS_STORE_BYTES)
        return value if isinstance(value, dict) else {}

    # ---- 内部工具 ----

    def _read_json(self, path: Path, max_bytes: int) -> Any:
        """读取 JSON 文件：缺失返回 None，体积超限/IO 失败抛 PiConfigError，
        JSON 格式错误按 None 处理（与 pi 一样不因单个文件损坏而崩溃）。"""
        if not path.is_file():
            return None
        try:
            if path.stat().st_size > max_bytes:
                raise PiConfigError(f"{path.name} exceeds {max_bytes} bytes")
            return json.loads(path.read_text(encoding="utf-8"))
        except PiConfigError:
            raise
        except OSError as exception:
            raise PiConfigError(f"{path.name} could not be read") from exception
        except json.JSONDecodeError:
            return None


def _optional_string(value: dict[str, Any], key: str) -> str | None:
    item = value.get(key)
    return item if isinstance(item, str) and item else None


def _heuristic_auth_key(name: str) -> str:
    """把 {NAME}_API_KEY 风格的环境变量名启发式映射为 auth.json 的 key 名：
    DEEPSEEK_API_KEY → deepseek，CUSTOM_API_KEY → custom。
    只作为映射表缺失时的兜底。"""
    if name.endswith("_API_KEY"):
        stripped = name[: -len("_API_KEY")].lower().replace("_", "-")
        if stripped:
            return stripped
    return name

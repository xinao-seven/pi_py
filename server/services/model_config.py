"""Credential-safe models.json storage and Web model catalog."""

from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

from pi_ai.providers.base import LLMProvider
from pi_ai.providers.registry import create_provider
from server.services.agent_registry import ProviderConfigurationError

ENV_REFERENCE = re.compile(r"^\$([A-Z_][A-Z0-9_]*)$")
THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"]


class ProviderAlias:
    def __init__(self, name: str, provider: LLMProvider) -> None:
        self.name = name
        self._provider = provider

    def stream(self, **kwargs):
        return self._provider.stream(**kwargs)

    def count_tokens(self, messages, model):
        return self._provider.count_tokens(messages, model)


class ModelConfigService:
    def __init__(self, agent_dir: str | Path) -> None:
        self.agent_dir = Path(agent_dir).expanduser().resolve()
        self.path = self.agent_dir / "models.json"

    def read(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {"providers": {}}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"providers": {}}
        return value if isinstance(value, dict) and isinstance(value.get("providers"), dict) else {"providers": {}}

    def write(self, value: dict[str, Any]) -> None:
        validated = self.validate(value)
        self.agent_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".models.{uuid4().hex}.tmp")
        temporary.write_text(
            json.dumps(validated, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        temporary.replace(self.path)

    def validate(self, value: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value, dict) or not isinstance(value.get("providers", {}), dict):
            raise ValueError("models config must contain a providers object")
        result = deepcopy(value)
        providers = result.setdefault("providers", {})
        for provider_name, provider in providers.items():
            if not isinstance(provider_name, str) or not provider_name.strip():
                raise ValueError("provider names must be non-empty strings")
            if not isinstance(provider, dict):
                raise ValueError(f"provider {provider_name!r} must be an object")
            api_key = provider.get("apiKey")
            if api_key is not None and (
                not isinstance(api_key, str) or ENV_REFERENCE.fullmatch(api_key) is None
            ):
                raise ValueError(
                    f"provider {provider_name!r} apiKey must reference an environment variable like $OPENAI_API_KEY"
                )
            models = provider.get("models", [])
            if models is not None and (
                not isinstance(models, list)
                or not all(isinstance(model, dict) and isinstance(model.get("id"), str) and model["id"].strip() for model in models)
            ):
                raise ValueError(f"provider {provider_name!r} models must contain non-empty ids")
        return result

    def resolve_provider(self, name: str) -> LLMProvider:
        provider_config = self.read().get("providers", {}).get(name)
        if not isinstance(provider_config, dict):
            return _environment_provider(name)
        backend = str(provider_config.get("api") or "openai-completions")
        built_in = "anthropic" if backend == "anthropic-messages" else "openai-compatible"
        reference = provider_config.get("apiKey")
        env_name = ENV_REFERENCE.fullmatch(reference).group(1) if isinstance(reference, str) and ENV_REFERENCE.fullmatch(reference) else _default_key_env(built_in)
        api_key = os.getenv(env_name)
        if not api_key:
            raise ProviderConfigurationError(f"Environment variable {env_name} is not set")
        provider = create_provider(
            built_in,
            api_key=api_key,
            base_url=provider_config.get("baseUrl") if isinstance(provider_config.get("baseUrl"), str) else None,
        )
        return provider if provider.name == name else ProviderAlias(name, provider)

    def catalog(
        self,
        *,
        default_provider: str,
        default_model: str,
    ) -> dict[str, Any]:
        config = self.read()
        model_list: list[dict[str, str]] = []
        thinking_levels: dict[str, list[str]] = {}
        for provider_name, provider in config.get("providers", {}).items():
            if not isinstance(provider, dict):
                continue
            for model in provider.get("models", []) or []:
                model_id = str(model["id"])
                name = str(model.get("name") or model_id)
                model_list.append({"id": model_id, "name": name, "provider": provider_name})
                thinking_levels[f"{provider_name}:{model_id}"] = list(THINKING_LEVELS)
        if not any(item["provider"] == default_provider and item["id"] == default_model for item in model_list):
            model_list.insert(0, {"id": default_model, "name": default_model, "provider": default_provider})
            thinking_levels[f"{default_provider}:{default_model}"] = list(THINKING_LEVELS)
        return {
            "models": {f"{item['provider']}:{item['id']}": item["name"] for item in model_list},
            "modelList": model_list,
            "defaultModel": {"provider": default_provider, "modelId": default_model},
            "thinkingLevels": thinking_levels,
            "thinkingLevelMaps": {},
        }


def _default_key_env(provider: str) -> str:
    return "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY"


def _environment_provider(name: str) -> LLMProvider:
    built_in = "openai-compatible" if name in {"openai", "openai-compatible"} else name
    env_name = _default_key_env(built_in)
    api_key = os.getenv(env_name)
    if not api_key:
        raise ProviderConfigurationError(f"Environment variable {env_name} is not set")
    return create_provider(built_in, api_key=api_key)

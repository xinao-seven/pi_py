"""Credential-safe models.json storage and Web model catalog."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

from pi_ai.providers.base import LLMProvider
from pi_ai.providers.registry import create_provider
from server.services.agent_registry import ProviderConfigurationError, ResolvedModel
from server.services.secret_store import SecretConfigError, SecretStore

ENV_REFERENCE = re.compile(r"^\$([A-Z_][A-Z0-9_]*)$")
THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]


class ProviderAlias:
    def __init__(self, name: str, provider: LLMProvider) -> None:
        self.name = name
        self._provider = provider

    def stream(self, **kwargs):
        return self._provider.stream(**kwargs)

    def count_tokens(self, messages, model):
        return self._provider.count_tokens(messages, model)


class ModelConfigService:
    def __init__(
        self,
        agent_dir: str | Path,
        *,
        secrets_file: str | Path | None = None,
    ) -> None:
        self.agent_dir = Path(agent_dir).expanduser().resolve()
        self.path = self.agent_dir / "models.json"
        self.secret_store = SecretStore(
            secrets_file or self.agent_dir / "secrets.env"
        )

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
                    f"provider {provider_name!r} apiKey must reference a secret variable like $OPENAI_API_KEY"
                )
            models = provider.get("models", [])
            if models is not None and (
                not isinstance(models, list)
                or not all(isinstance(model, dict) and isinstance(model.get("id"), str) and model["id"].strip() for model in models)
            ):
                raise ValueError(f"provider {provider_name!r} models must contain non-empty ids")
            for model in models or []:
                context_window = model.get("contextWindow")
                if context_window is not None and (
                    not isinstance(context_window, int)
                    or isinstance(context_window, bool)
                    or context_window <= 0
                ):
                    raise ValueError(
                        f"model {provider_name}:{model['id']} contextWindow must be a positive integer"
                    )
                reasoning = model.get("reasoning")
                if reasoning is not None and not isinstance(reasoning, bool):
                    raise ValueError(
                        f"model {provider_name}:{model['id']} reasoning must be a boolean"
                    )
                levels = model.get("thinkingLevels")
                if levels is not None and (
                    not isinstance(levels, list)
                    or not levels
                    or not all(level in THINKING_LEVELS for level in levels)
                ):
                    raise ValueError(
                        f"model {provider_name}:{model['id']} thinkingLevels contains an unsupported level"
                    )
        return result

    def resolve_provider(self, name: str) -> LLMProvider:
        provider_config = self.read().get("providers", {}).get(name)
        if not isinstance(provider_config, dict):
            return _environment_provider(name, self.secret_store)
        backend = str(provider_config.get("api") or "openai-completions")
        if backend == "anthropic-messages":
            built_in = "anthropic"
        elif backend == "deepseek-chat-completions":
            built_in = "deepseek"
        else:
            built_in = "openai-compatible"
        reference = provider_config.get("apiKey")
        env_name = ENV_REFERENCE.fullmatch(reference).group(1) if isinstance(reference, str) and ENV_REFERENCE.fullmatch(reference) else _default_key_env(built_in)
        try:
            api_key = self.secret_store.resolve(env_name)
        except SecretConfigError as exception:
            raise ProviderConfigurationError(str(exception)) from exception
        if not api_key:
            raise ProviderConfigurationError(
                f"Secret {env_name} was not found in the environment or secrets file"
            )
        provider = create_provider(
            built_in,
            api_key=api_key,
            base_url=provider_config.get("baseUrl") if isinstance(provider_config.get("baseUrl"), str) else None,
        )
        return provider if provider.name == name else ProviderAlias(name, provider)

    def resolve_model(self, provider_name: str, model_id: str) -> ResolvedModel:
        provider = self.read().get("providers", {}).get(provider_name)
        if not isinstance(provider, dict):
            return ResolvedModel(provider_name, model_id)
        model = next(
            (
                item
                for item in provider.get("models", []) or []
                if isinstance(item, dict) and item.get("id") == model_id
            ),
            None,
        )
        context_window = model.get("contextWindow", 0) if isinstance(model, dict) else 0
        return ResolvedModel(
            provider_name,
            model_id,
            context_window
            if isinstance(context_window, int)
            and not isinstance(context_window, bool)
            and context_window > 0
            else 0,
        )

    def catalog(
        self,
        *,
        default_provider: str,
        default_model: str,
    ) -> dict[str, Any]:
        config = self.read()
        model_list: list[dict[str, Any]] = []
        thinking_levels: dict[str, list[str]] = {}
        thinking_level_maps: dict[str, dict[str, Any]] = {}
        for provider_name, provider in config.get("providers", {}).items():
            if not isinstance(provider, dict):
                continue
            for model in provider.get("models", []) or []:
                model_id = str(model["id"])
                name = str(model.get("name") or model_id)
                model_item: dict[str, Any] = {
                    "id": model_id,
                    "name": name,
                    "provider": provider_name,
                }
                context_window = model.get("contextWindow")
                if (
                    isinstance(context_window, int)
                    and not isinstance(context_window, bool)
                    and context_window > 0
                ):
                    model_item["contextWindow"] = context_window
                model_list.append(model_item)
                key = f"{provider_name}:{model_id}"
                configured_levels = model.get("thinkingLevels")
                if isinstance(configured_levels, list):
                    thinking_levels[key] = list(configured_levels)
                elif model.get("reasoning") is False:
                    thinking_levels[key] = ["off"]
                else:
                    thinking_levels[key] = list(THINKING_LEVELS)
                level_map = model.get("thinkingLevelMap")
                if isinstance(level_map, dict):
                    thinking_level_maps[key] = deepcopy(level_map)
        if not any(item["provider"] == default_provider and item["id"] == default_model for item in model_list):
            model_list.insert(0, {"id": default_model, "name": default_model, "provider": default_provider})
            thinking_levels[f"{default_provider}:{default_model}"] = list(THINKING_LEVELS)
        return {
            "models": {f"{item['provider']}:{item['id']}": item["name"] for item in model_list},
            "modelList": model_list,
            "defaultModel": {"provider": default_provider, "modelId": default_model},
            "thinkingLevels": thinking_levels,
            "thinkingLevelMaps": thinking_level_maps,
        }


def _default_key_env(provider: str) -> str:
    if provider == "anthropic":
        return "ANTHROPIC_API_KEY"
    if provider == "deepseek":
        return "DEEPSEEK_API_KEY"
    return "OPENAI_API_KEY"


def _environment_provider(name: str, secret_store: SecretStore) -> LLMProvider:
    built_in = "openai-compatible" if name in {"openai", "openai-compatible"} else name
    env_name = _default_key_env(built_in)
    try:
        api_key = secret_store.resolve(env_name)
    except SecretConfigError as exception:
        raise ProviderConfigurationError(str(exception)) from exception
    if not api_key:
        raise ProviderConfigurationError(
            f"Secret {env_name} was not found in the environment or secrets file"
        )
    return create_provider(built_in, api_key=api_key)

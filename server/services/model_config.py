"""Merged model catalog and credential-safe provider resolution.

中文说明：模型配置服务：

- 原版 pi 的 models-store.json（内置模型缓存）与 models.json（用户覆盖）
  只读合并进目录，绝不写回，避免影响原版 pi 的运行；
- pi.py 自身通过 Web 编辑器改写的模型配置保存在独立的
  ~/.pi/agent-python/models.json（apiKey 只允许 $ENV_VAR 引用）；
- 密钥只从原版 pi 的 auth.json 解析（见 PiConfig），不读取环境变量，
  解析后的真实密钥绝不会通过 API 返回。
"""

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
from server.services.pi_config import PiConfig

ENV_REFERENCE = re.compile(r"^\$([A-Z_][A-Z0-9_]*)$")
# 全部思考档位（与前端选项一致）
THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]


class ProviderAlias:
    """名称别名适配：models.json 里的自定义 provider 名映射到内置 Provider。"""
    def __init__(self, name: str, provider: LLMProvider) -> None:
        self.name = name
        self._provider = provider

    def stream(self, **kwargs):
        return self._provider.stream(**kwargs)

    def count_tokens(self, messages, model):
        return self._provider.count_tokens(messages, model)


class ModelConfigService:
    """pi 模型目录（只读）+ pi.py 自身覆盖的合并视图、Provider 解析与 Web 目录。"""
    def __init__(
        self,
        pi_config: PiConfig,
        own_config_dir: str | Path,
    ) -> None:
        self.pi_config = pi_config
        self.own_config_dir = Path(own_config_dir).expanduser().resolve()
        # pi.py 自身可写的模型覆盖文件（Web 编辑器读写，与原版 pi 隔离）
        self.path = self.own_config_dir / "models.json"

    # ---- pi.py 自身的模型覆盖（Web 编辑器）----

    def read(self) -> dict[str, Any]:
        """读取 pi.py 自身的 models.json；缺失或损坏时返回空配置。"""
        if not self.path.is_file():
            return {"providers": {}}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"providers": {}}
        return (
            value
            if isinstance(value, dict) and isinstance(value.get("providers"), dict)
            else {"providers": {}}
        )

    def write(self, value: dict[str, Any]) -> None:
        """校验后原子写入 pi.py 自身的 models.json（绝不动原版 pi 的文件）。"""
        validated = self.validate(value)
        self.own_config_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".models.{uuid4().hex}.tmp")
        temporary.write_text(
            json.dumps(validated, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        temporary.replace(self.path)

    def validate(self, value: dict[str, Any]) -> dict[str, Any]:
        """校验 pi.py 自身配置的结构：provider 名称、apiKey 必须是 $ENV_VAR 引用、
        模型 id/contextWindow/reasoning/thinkingLevels 的合法性。"""
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

    # ---- 合并目录 ----

    def _merged_providers(self) -> dict[str, dict[str, Any]]:
        """按优先级合并三份只读来源：models-store.json 内置目录（元数据最全）
        → pi models.json 用户覆盖 → pi.py 自身覆盖（Web 编辑器）。
        Provider 级字段后者覆盖前者，模型按 id 覆盖，避免丢失内置元数据。"""
        merged: dict[str, dict[str, Any]] = {}
        for name, store in self.pi_config.read_models_store().items():
            if isinstance(store, dict) and isinstance(store.get("models"), list):
                merged[str(name)] = {
                    "models": [
                        deepcopy(model)
                        for model in store["models"]
                        if isinstance(model, dict)
                    ]
                }
        self._overlay(merged, self.pi_config.read_models())
        self._overlay(merged, self.read())
        return merged

    @staticmethod
    def _overlay(
        merged: dict[str, dict[str, Any]],
        config: dict[str, Any],
    ) -> None:
        """把一份 {"providers": {...}} 覆盖到合并视图上（模型按 id 合并）。"""
        for name, provider in config.get("providers", {}).items():
            if not isinstance(provider, dict):
                continue
            target = merged.setdefault(str(name), {})
            for key, value in provider.items():
                if key == "models":
                    if isinstance(value, list):
                        _merge_models(
                            target.setdefault("models", []),
                            value,
                        )
                else:
                    target[key] = deepcopy(value)

    # ---- Provider / 模型解析 ----

    def resolve_provider(self, name: str) -> LLMProvider:
        """按合并配置构造 Provider：api 字段决定内置类型，
        密钥只从原版 pi 的 auth.json 解析（绝不在 API 中返回）。"""
        provider_config = self._merged_providers().get(name)
        if not isinstance(provider_config, dict):
            return _auth_provider(name, self.pi_config)
        backend = str(
            provider_config.get("api")
            or _first_model_value(provider_config, "api")
            or "openai-completions"
        )
        built_in = _built_in_provider(name, backend)
        try:
            api_key = self._resolve_api_key(name, provider_config)
        except ProviderConfigurationError:
            raise
        base_url = provider_config.get("baseUrl")
        if not isinstance(base_url, str) or not base_url:
            base_url = _first_model_value(provider_config, "baseUrl")
        provider = create_provider(
            built_in,
            api_key=api_key,
            base_url=base_url if isinstance(base_url, str) and base_url else None,
        )
        return provider if provider.name == name else ProviderAlias(name, provider)

    def _resolve_api_key(
        self,
        provider_name: str,
        provider_config: dict[str, Any],
    ) -> str:
        """解析 Provider 密钥：优先 $ENV_VAR 引用（按 auth.json 的 key 名映射），
        其次 literal apiKey（只读自 pi 配置，不写入），最后按 Provider 名查 auth.json。"""
        reference = provider_config.get("apiKey")
        if isinstance(reference, str) and reference:
            env_match = ENV_REFERENCE.fullmatch(reference)
            if env_match is not None:
                api_key = self.pi_config.resolve_api_key(env_match.group(1))
            else:
                api_key = reference
        else:
            api_key = self.pi_config.resolve_api_key(provider_name)
        if not api_key:
            raise ProviderConfigurationError(
                f"No API key found for provider {provider_name!r} in ~/.pi/agent/auth.json"
            )
        return api_key

    def resolve_model(self, provider_name: str, model_id: str) -> ResolvedModel:
        """解析模型元数据（主要取上下文窗口），供 Agent 上下文管理使用。"""
        provider = self._merged_providers().get(provider_name)
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
        """生成 Web 模型目录：模型列表、默认模型、各模型的思考档位与映射。"""
        config = self._merged_providers()
        model_list: list[dict[str, Any]] = []
        thinking_levels: dict[str, list[str]] = {}
        thinking_level_maps: dict[str, dict[str, Any]] = {}
        for provider_name, provider in config.items():
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


def _merge_models(target: list[dict[str, Any]], incoming: list[Any]) -> None:
    """把 incoming 里的模型按 id 合并进 target：同 id 替换，新 id 追加。"""
    by_id = {
        str(model["id"]): index
        for index, model in enumerate(target)
        if isinstance(model, dict) and isinstance(model.get("id"), str)
    }
    for model in incoming:
        if not isinstance(model, dict) or not isinstance(model.get("id"), str):
            continue
        index = by_id.get(model["id"])
        if index is None:
            by_id[model["id"]] = len(target)
            target.append(deepcopy(model))
        else:
            target[index] = deepcopy(model)


def _first_model_value(provider_config: dict[str, Any], key: str) -> Any:
    """取 provider 下第一个模型里的字段值（models-store 把 api/baseUrl 放在模型级）。"""
    for model in provider_config.get("models", []) or []:
        if isinstance(model, dict) and isinstance(model.get(key), str) and model[key]:
            return model[key]
    return None


def _built_in_provider(name: str, backend: str) -> str:
    """把合并配置里的 provider 名 / api 值映射到内置 Provider 类型。"""
    if name == "anthropic" or backend == "anthropic-messages":
        return "anthropic"
    if name == "deepseek" or backend == "deepseek-chat-completions":
        return "deepseek"
    return "openai-compatible"


def _auth_provider(name: str, pi_config: PiConfig) -> LLMProvider:
    """无 models.json 配置时的回退：按 Provider 名从 auth.json 解析密钥。"""
    built_in = _built_in_provider(name, "openai-completions")
    api_key = pi_config.resolve_api_key(name)
    if not api_key:
        raise ProviderConfigurationError(
            f"No API key found for provider {name!r} in ~/.pi/agent/auth.json; "
            "use /login in pi or add the key to auth.json"
        )
    return create_provider(built_in, api_key=api_key)

from pathlib import Path

import pytest

from server.services.pi_config import (
    PiConfig,
    PiConfigError,
    PiUserSettings,
)


# models_store 关键字映射到 models-store.json（点号文件名特例）
_FILE_NAMES = {"models_store_json": "models-store.json"}


def _agent_dir(tmp_path: Path, **files) -> Path:
    """构造一个包含指定文件的 ~/.pi/agent 风格的测试目录。
    关键字名用下划线风格（auth_json），写入时转为点号文件名（auth.json）。"""
    agent_dir = tmp_path / "agent"
    agent_dir.mkdir()
    for name, content in files.items():
        filename = _FILE_NAMES.get(name, name.replace("_", "."))
        (agent_dir / filename).write_text(content, encoding="utf-8")
    return agent_dir


def test_resolve_api_key_from_auth_json(tmp_path: Path) -> None:
    agent_dir = _agent_dir(
        tmp_path,
        auth_json=(
            '{"deepseek": {"type": "api_key", "key": "sk-deepseek"},'
            ' "anthropic": {"type": "api_key", "key": "sk-anthropic"}}\n'
        ),
    )
    config = PiConfig(agent_dir)

    # 内置 Provider 名
    assert config.resolve_api_key("deepseek") == "sk-deepseek"
    assert config.resolve_api_key("anthropic") == "sk-anthropic"
    # $ENV_VAR 引用名映射
    assert config.resolve_api_key("DEEPSEEK_API_KEY") == "sk-deepseek"
    assert config.resolve_api_key("ANTHROPIC_API_KEY") == "sk-anthropic"
    # 未知 Provider：不读环境变量，返回 None
    assert config.resolve_api_key("unknown-provider") is None
    # openai-compatible 别名映射到 openai
    assert config.resolve_api_key("openai-compatible") is None


def test_resolve_api_key_maps_compatible_provider_to_openai(tmp_path: Path) -> None:
    agent_dir = _agent_dir(
        tmp_path,
        auth_json='{"openai": {"type": "api_key", "key": "sk-openai"}}\n',
    )
    config = PiConfig(agent_dir)

    assert config.resolve_api_key("openai") == "sk-openai"
    assert config.resolve_api_key("openai-compatible") == "sk-openai"
    assert config.resolve_api_key("OPENAI_API_KEY") == "sk-openai"


def test_missing_or_malformed_auth_json_is_empty(tmp_path: Path) -> None:
    empty = PiConfig(tmp_path / "missing")
    assert empty.read_auth() == {}
    assert empty.resolve_api_key("deepseek") is None

    broken = _agent_dir(tmp_path, auth_json="not json {")
    assert PiConfig(broken).read_auth() == {}
    assert PiConfig(broken).resolve_api_key("deepseek") is None


def test_read_settings_from_settings_json(tmp_path: Path) -> None:
    agent_dir = _agent_dir(
        tmp_path,
        settings_json=(
            '{"theme": "dark", "defaultProvider": "deepseek",'
            ' "defaultModel": "deepseek-v4-flash", "defaultThinkingLevel": "high"}\n'
        ),
    )

    settings = PiConfig(agent_dir).read_settings()

    assert settings == PiUserSettings(
        default_provider="deepseek",
        default_model="deepseek-v4-flash",
        default_thinking_level="high",
        theme="dark",
    )


def test_missing_settings_return_empty_defaults(tmp_path: Path) -> None:
    settings = PiConfig(tmp_path / "missing").read_settings()
    assert settings == PiUserSettings()
    assert settings.default_provider is None


def test_read_models_and_models_store(tmp_path: Path) -> None:
    agent_dir = _agent_dir(
        tmp_path,
        models_json=(
            '{"providers": {"ollama": {"baseUrl": "http://localhost:11434/v1",'
            ' "api": "openai-completions", "models": [{"id": "llama3"}]}}}\n'
        ),
        models_store_json=(
            '{"deepseek": {"models": [{"id": "deepseek-v4-flash",'
            ' "contextWindow": 1000000}]}}\n'
        ),
    )
    config = PiConfig(agent_dir)

    assert config.read_models()["providers"]["ollama"]["baseUrl"] == (
        "http://localhost:11434/v1"
    )
    assert config.read_models_store()["deepseek"]["models"][0]["id"] == (
        "deepseek-v4-flash"
    )


def test_read_models_falls_back_to_empty_providers(tmp_path: Path) -> None:
    config = PiConfig(tmp_path / "missing")
    assert config.read_models() == {"providers": {}}
    assert config.read_models_store() == {}


def test_oversized_auth_file_raises(tmp_path: Path) -> None:
    agent_dir = _agent_dir(tmp_path)
    (agent_dir / "auth.json").write_text(
        '{"key": "' + "x" * (512 * 1024) + '"}',
        encoding="utf-8",
    )

    with pytest.raises(PiConfigError, match="exceeds"):
        PiConfig(agent_dir).read_auth()

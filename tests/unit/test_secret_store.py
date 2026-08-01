from pathlib import Path

import pytest

from server.services.secret_store import SecretConfigError, SecretStore


def test_secret_store_reads_dotenv_syntax(tmp_path: Path) -> None:
    path = tmp_path / "secrets.env"
    path.write_text(
        "# provider credentials\n"
        "ANTHROPIC_API_KEY='anthropic-secret'\n"
        'export OPENAI_API_KEY="openai-secret"\n'
        "EMPTY_SECRET=\n",
        encoding="utf-8",
    )

    assert SecretStore(path).read() == {
        "ANTHROPIC_API_KEY": "anthropic-secret",
        "OPENAI_API_KEY": "openai-secret",
        "EMPTY_SECRET": "",
    }


def test_environment_overrides_secrets_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "secrets.env"
    path.write_text("OPENAI_API_KEY=file-secret\n", encoding="utf-8")
    monkeypatch.setenv("OPENAI_API_KEY", "environment-secret")

    assert SecretStore(path).resolve("OPENAI_API_KEY") == "environment-secret"


def test_invalid_secret_entry_does_not_leak_value(tmp_path: Path) -> None:
    path = tmp_path / "secrets.env"
    path.write_text("invalid-name=do-not-leak\n", encoding="utf-8")

    with pytest.raises(SecretConfigError) as captured:
        SecretStore(path).read()

    assert "line 1" in str(captured.value)
    assert "do-not-leak" not in str(captured.value)

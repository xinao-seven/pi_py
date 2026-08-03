"""Local dotenv-style secret loading with environment-variable precedence.

中文说明：密钥存储：从仓库外的 secrets.env 读取密钥，
进程环境变量优先于文件；只提供解析，绝不向 API 返回真实密钥。
"""

from __future__ import annotations

import os
from pathlib import Path
import re


SECRET_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
MAX_SECRET_FILE_BYTES = 64 * 1024


class SecretConfigError(ValueError):
    """Raised when the local secrets file is malformed or cannot be read.

    中文说明：secrets.env 格式错误或不可读时抛出。
    """


class SecretStore:
    """解析 secrets.env（dotenv 风格，支持引号值与 export 前缀）。"""
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser().resolve()

    def resolve(self, name: str) -> str | None:
        """Resolve a secret, preferring the current process environment.

        中文说明：解析密钥：进程环境变量优先，其次读 secrets.env 文件。
        """
        if name in os.environ:
            return os.environ[name]
        return self.read().get(name)

    def read(self) -> dict[str, str]:
        """解析密钥文件：跳过注释/空行，校验变量名与引号配对。"""
        if not self.path.is_file():
            return {}
        try:
            if self.path.stat().st_size > MAX_SECRET_FILE_BYTES:
                raise SecretConfigError(
                    f"Secrets file exceeds {MAX_SECRET_FILE_BYTES} bytes"
                )
            content = self.path.read_text(encoding="utf-8-sig")
        except SecretConfigError:
            raise
        except OSError as exception:
            raise SecretConfigError("Secrets file could not be read") from exception

        values: dict[str, str] = {}
        for line_number, raw_line in enumerate(content.splitlines(), start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            if "=" not in line:
                raise SecretConfigError(
                    f"Invalid secrets file entry on line {line_number}"
                )
            name, value = line.split("=", 1)
            name = name.strip()
            value = value.strip()
            if SECRET_NAME.fullmatch(name) is None:
                raise SecretConfigError(
                    f"Invalid secret name on line {line_number}"
                )
            if value[:1] in {'\"', "'"}:
                if len(value) < 2 or value[-1] != value[0]:
                    raise SecretConfigError(
                        f"Unterminated quoted value on line {line_number}"
                    )
                value = value[1:-1]
            values[name] = value
        return values

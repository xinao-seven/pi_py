"""Workspace-scoped file browsing and preview operations.

中文说明：文件服务：目录浏览、文本/媒体预览与变化监听。
所有访问先校验根目录白名单，再做真实路径边界与敏感文件检查。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Iterable
from datetime import datetime, timezone
import json
import mimetypes
from pathlib import Path
from typing import Any


IGNORED_NAMES = {
    # 目录浏览时忽略的重型/生成目录
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    "__pycache__",
    ".turbo",
    ".cache",
    "coverage",
    ".pytest_cache",
    ".mypy_cache",
    "target",
    "vendor",
    ".DS_Store",
}
IGNORED_SUFFIXES = {".pyc"}
SENSITIVE_DIRECTORY_NAMES = {".ssh", ".aws", ".azure", ".gnupg"}
# 禁止预览的敏感文件/后缀（.env、密钥、凭据等）
SENSITIVE_FILE_NAMES = {".env", "secrets.env", "credentials", "credentials.json"}
SENSITIVE_SUFFIXES = {".pem", ".key", ".p12", ".pfx"}
TEXT_PREVIEW_MAX_BYTES = 256 * 1024
MEDIA_PREVIEW_MAX_BYTES = 10 * 1024 * 1024

EXT_TO_LANGUAGE = {
    "ts": "typescript",
    "tsx": "typescript",
    "js": "javascript",
    "jsx": "javascript",
    "mjs": "javascript",
    "cjs": "javascript",
    "py": "python",
    "rb": "ruby",
    "go": "go",
    "rs": "rust",
    "java": "java",
    "kt": "kotlin",
    "swift": "swift",
    "c": "c",
    "cpp": "cpp",
    "h": "c",
    "hpp": "cpp",
    "cs": "csharp",
    "html": "html",
    "htm": "html",
    "css": "css",
    "scss": "css",
    "less": "css",
    "json": "json",
    "jsonl": "json",
    "yaml": "yaml",
    "yml": "yaml",
    "toml": "toml",
    "xml": "xml",
    "md": "markdown",
    "mdx": "markdown",
    "sh": "bash",
    "bash": "bash",
    "zsh": "bash",
    "sql": "sql",
    "graphql": "graphql",
    "gql": "graphql",
    "tf": "hcl",
    "hcl": "hcl",
    "gitignore": "bash",
    "txt": "text",
}


class FileAccessError(Exception):
    """文件访问错误：状态码 + 机器码 + 消息，路由转成 APIError。"""
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class FileService:
    """工作区文件操作：roots_provider 动态提供允许的根目录集合。"""
    def __init__(self, roots_provider: Callable[[], Iterable[str | Path]]) -> None:
        self._roots_provider = roots_provider

    def allowed_roots(self) -> tuple[Path, ...]:
        """解析并去重当前允许的根目录。"""
        unique: dict[str, Path] = {}
        for root in self._roots_provider():
            resolved = Path(root).expanduser().resolve()
            unique[_path_key(resolved)] = resolved
        return tuple(unique.values())

    def resolve(self, file_path: str, root_path: str) -> tuple[Path, Path]:
        """解析目标路径：根目录必须白名单内，解析后必须仍位于根内，且不是敏感文件。"""
        root = Path(root_path).expanduser().resolve()
        allowed = {_path_key(item) for item in self.allowed_roots()}
        if _path_key(root) not in allowed:
            raise FileAccessError(403, "root_not_allowed", "Workspace root is not allowed")

        candidate = Path(file_path).expanduser()
        if not candidate.is_absolute():
            candidate = root / candidate
        resolved = candidate.resolve()
        try:
            resolved.relative_to(root)
        except ValueError as exception:
            raise FileAccessError(
                403,
                "path_outside_workspace",
                "Path escapes the selected workspace",
            ) from exception
        if _is_sensitive(resolved, root):
            raise FileAccessError(403, "sensitive_file", "Sensitive files cannot be previewed")
        return resolved, root

    def list_directory(self, file_path: str, root_path: str) -> dict[str, Any]:
        """列目录：过滤忽略项，返回名称/类型/大小/修改时间，目录优先排序。"""
        target, _ = self.resolve(file_path, root_path)
        if not target.exists():
            raise FileAccessError(404, "file_not_found", "Directory was not found")
        if not target.is_dir():
            raise FileAccessError(400, "not_a_directory", "Path is not a directory")
        entries: list[dict[str, Any]] = []
        for child in target.iterdir():
            if _should_ignore(child):
                continue
            try:
                stat = child.stat()
            except OSError:
                continue
            entries.append(
                {
                    "name": child.name,
                    "isDir": child.is_dir(),
                    "size": stat.st_size if child.is_file() else 0,
                    "modified": datetime.fromtimestamp(
                        stat.st_mtime,
                        timezone.utc,
                    ).isoformat(),
                }
            )
        entries.sort(key=lambda item: (not item["isDir"], item["name"].casefold()))
        return {"entries": entries, "path": str(target)}

    def read_text(self, file_path: str, root_path: str) -> dict[str, Any]:
        """读文本预览：限制大小与 UTF-8 编码，附带语法高亮语言。"""
        target, _ = self.resolve(file_path, root_path)
        stat = self._file_stat(target)
        if stat.st_size > TEXT_PREVIEW_MAX_BYTES:
            raise FileAccessError(
                413,
                "file_too_large",
                f"Text preview exceeds {TEXT_PREVIEW_MAX_BYTES} bytes",
            )
        try:
            content = target.read_text(encoding="utf-8")
        except UnicodeDecodeError as exception:
            raise FileAccessError(
                415,
                "binary_file",
                "File is not valid UTF-8 text",
            ) from exception
        return {
            "content": content,
            "language": guess_language(target),
            "size": stat.st_size,
        }

    def media_file(self, file_path: str, root_path: str) -> tuple[Path, str]:
        """返回可预览的媒体文件（图片/音频）及其 MIME。"""
        target, _ = self.resolve(file_path, root_path)
        stat = self._file_stat(target)
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if not (mime.startswith("image/") or mime.startswith("audio/")):
            raise FileAccessError(415, "unsupported_media", "File is not previewable media")
        if stat.st_size > MEDIA_PREVIEW_MAX_BYTES:
            raise FileAccessError(
                413,
                "file_too_large",
                f"Media preview exceeds {MEDIA_PREVIEW_MAX_BYTES} bytes",
            )
        return target, mime

    async def watch(
        self,
        file_path: str,
        root_path: str,
        *,
        poll_seconds: float = 1,
    ) -> AsyncIterator[str]:
        """轮询监听文件变化，通过 SSE 推送 change 事件（附带心跳）。"""
        target, _ = self.resolve(file_path, root_path)
        stat = self._file_stat(target)
        previous = (stat.st_mtime_ns, stat.st_size)
        yield _named_sse("connected", {"filePath": str(target)})
        while True:
            await asyncio.sleep(max(0.1, poll_seconds))
            try:
                stat = target.stat()
                current = (stat.st_mtime_ns, stat.st_size)
            except OSError:
                current = (0, 0)
            if current == previous:
                yield ": heartbeat\n\n"
                continue
            previous = current
            yield _named_sse(
                "change",
                {
                    "mtime": datetime.now(timezone.utc).isoformat(),
                    "size": current[1],
                },
            )

    @staticmethod
    def _file_stat(target: Path):
        if not target.exists():
            raise FileAccessError(404, "file_not_found", "File was not found")
        if not target.is_file():
            raise FileAccessError(400, "not_a_file", "Path is not a file")
        return target.stat()


def guess_language(path: Path) -> str:
    """按文件名/后缀猜测代码语言，用于前端高亮。"""
    base = path.name.casefold()
    if base == "dockerfile" or base.startswith("dockerfile."):
        return "dockerfile"
    if base in {"makefile", "gnumakefile"}:
        return "makefile"
    return EXT_TO_LANGUAGE.get(path.suffix.casefold().removeprefix("."), "text")


def _path_key(path: Path) -> str:
    return str(path).casefold()


def _is_sensitive(path: Path, root: Path) -> bool:
    """敏感判定：敏感目录、.env/密钥文件、凭据后缀、.git/config 等。"""
    relative_parts = [part.casefold() for part in path.relative_to(root).parts]
    if any(part in SENSITIVE_DIRECTORY_NAMES for part in relative_parts):
        return True
    name = path.name.casefold()
    return (
        name in SENSITIVE_FILE_NAMES
        or name.startswith(".env.")
        or path.suffix.casefold() in SENSITIVE_SUFFIXES
        or (name == "config" and ".git" in relative_parts)
    )


def _should_ignore(path: Path) -> bool:
    """目录浏览时是否忽略：重型目录、敏感文件、pyc/密钥后缀。"""
    name = path.name.casefold()
    return (
        name in {item.casefold() for item in IGNORED_NAMES}
        or name in SENSITIVE_FILE_NAMES
        or name.startswith(".env.")
        or path.suffix.casefold() in IGNORED_SUFFIXES | SENSITIVE_SUFFIXES
    )


def _named_sse(event: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"

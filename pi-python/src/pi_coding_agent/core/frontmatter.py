"""Small dependency-free Markdown frontmatter parser.

中文说明：零依赖的极简 Markdown frontmatter 解析器（用于 SKILL.md/模板文件头）。
"""

from __future__ import annotations

from typing import Any


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """解析以 --- 包裹的元数据块：支持键值对、引号值与 true/false 布尔。
    返回 (元数据, 正文)。无 frontmatter 时原样返回正文。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if end is None:
        return {}, text
    metadata: dict[str, Any] = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, raw = line.split(":", 1)
        value = raw.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if value.lower() in {"true", "false"}:
            metadata[key.strip()] = value.lower() == "true"
        else:
            metadata[key.strip()] = value
    body = "\n".join(lines[end + 1 :])
    if text.endswith("\n"):
        body += "\n"
    return metadata, body

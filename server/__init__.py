"""FastAPI application layer for the Python pi-agent implementation.

中文说明：FastAPI 应用层（位于三层 Python 核心之上），只负责 HTTP DTO、
生命周期与安全边界，核心包不得反向依赖本层。
"""

from server.main import create_app

__all__ = ["create_app"]

"""FastAPI application layer for the Python pi-agent implementation.

中文说明：FastAPI 应用层（位于三层 Python 核心之上），只负责 HTTP DTO、
生命周期与安全边界，核心包不得反向依赖本层。
"""

import sys
from pathlib import Path

# src-layout：把内核包目录 src/ 加入 sys.path，使 uvicorn 直接以
# `python -m uvicorn server.main:app` 启动时也能 import pi_ai/pi_agent/pi_coding_agent。
_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from server.main import create_app

__all__ = ["create_app"]

"""Transient provider error classification and retry policy.

中文说明：对 Provider 返回的错误进行分类并决定是否自动重试。
额度/计费类错误直接放弃，临时故障（过载、限流、网络中断、超时）按指数退避重试。
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

# 命中这些关键词的错误属于永久性/计费类问题（额度、余额、配额），重试没有意义
_NON_RETRYABLE_LIMIT = re.compile(
    r"GoUsageLimitError|FreeUsageLimitError|monthly usage limit reached|available balance|"
    r"insufficient_quota|out of budget|quota exceeded|billing",
    re.IGNORECASE,
)
# 命中这些关键词的错误属于临时故障（过载、限流、网络中断、超时等），值得自动重试
_RETRYABLE = re.compile(
    r"overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|524)\b|"
    r"service.?unavailable|server.?error|internal.?error|provider.?returned.?error|"
    r"network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|"
    r"fetch failed|upstream.?connect|reset before headers|socket hang up|"
    r"socket connection was closed|timed? out|timeout|terminated|websocket.?closed|"
    r"websocket.?error|ended without|stream ended before message_stop|"
    r"stream ended before a terminal response event|http2 request did not get a response|"
    r"retry delay|you can retry your request|try your request again|please retry your request|"
    r"ResourceExhausted",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Bounded exponential backoff; the initial request is not a retry.

    中文说明：有上限的指数退避策略；首次请求不算重试，
    第 N 次重试的等待时间为 base_delay * 2^(N-1) 秒。
    """

    enabled: bool = True
    max_retries: int = 3
    base_delay_seconds: float = 2.0

    def __post_init__(self) -> None:
        if self.max_retries < 0:
            raise ValueError("max_retries must not be negative")
        if self.base_delay_seconds < 0:
            raise ValueError("base_delay_seconds must not be negative")

    def delay_for_attempt(self, attempt: int) -> float:
        if attempt < 1:
            raise ValueError("attempt must be at least 1")
        # 指数退避：base、2*base、4*base ...
        return self.base_delay_seconds * 2 ** (attempt - 1)


def is_retryable_assistant_error(message: dict[str, Any]) -> bool:
    """判断 assistant 错误消息是否值得重试：先排除额度类错误，再看是否命中临时故障关键词。"""
    if message.get("stopReason") != "error" or not message.get("errorMessage"):
        return False
    error = str(message["errorMessage"])
    if _NON_RETRYABLE_LIMIT.search(error):
        return False
    return bool(_RETRYABLE.search(error))

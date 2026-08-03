"""Minimal streaming HTTP boundary shared by real provider adapters.

中文说明：真实 Provider 共用的最小 HTTP/SSE 边界。生产环境使用 httpx 实现，
测试时注入内存 transport 模拟流，不需要真实 API Key 也能验证映射逻辑。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
import json
from typing import Any, Protocol


class ProviderHTTPError(RuntimeError):
    """Raised when a provider returns a non-success response or invalid SSE.

    中文说明：Provider 返回非成功响应或非法 SSE 数据时抛出。
    """


class SSETransport(Protocol):
    # 流式 POST：发起请求并按 SSE 帧返回 JSON 数据包字典
    def stream_sse(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        json_body: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]: ...


class HttpxSSETransport:
    """Production SSE transport; tests inject an in-memory implementation.

    中文说明：生产环境基于 httpx 的 SSE 传输层。SSE 协议按空行切分事件，
    每个事件由若干 "data:" 行拼接成 JSON；"[DONE]" 表示流结束。
    """

    def __init__(self, *, timeout: float = 120.0) -> None:
        self.timeout = timeout

    async def stream_sse(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        json_body: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream("POST", url, headers=dict(headers), json=json_body) as response:
                    if response.is_error:
                        # 非成功响应：读取响应体并抛出带状态码的错误
                        body = (await response.aread()).decode(errors="replace")
                        raise ProviderHTTPError(f"HTTP {response.status_code}: {body[:1000]}")
                    data_lines: list[str] = []
                    async for line in response.aiter_lines():
                        if not line:
                            # 空行 = 一个 SSE 事件的结束，把已收集的 data: 行解析成一个包
                            event = self._decode(data_lines)
                            data_lines.clear()
                            if event is not None:
                                yield event
                            continue
                        if line.startswith("data:"):
                            # 只收集 data: 行，去掉前缀与行首空白
                            data_lines.append(line[5:].lstrip())
                    event = self._decode(data_lines)
                    if event is not None:
                        yield event
        except httpx.HTTPError as exception:
            raise ProviderHTTPError(str(exception)) from exception

    @staticmethod
    def _decode(data_lines: list[str]) -> dict[str, Any] | None:
        """把若干 data: 行拼接为 JSON 对象；[DONE] 或无数据返回 None。"""
        if not data_lines:
            return None
        data = "\n".join(data_lines)
        if data == "[DONE]":
            return None
        try:
            value = json.loads(data)
        except json.JSONDecodeError as exception:
            raise ProviderHTTPError(f"Invalid SSE JSON: {data[:200]}") from exception
        if not isinstance(value, dict):
            raise ProviderHTTPError("Provider SSE payload must be a JSON object")
        return value

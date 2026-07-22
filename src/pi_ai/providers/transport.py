"""Minimal streaming HTTP boundary shared by real provider adapters."""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
import json
from typing import Any, Protocol


class ProviderHTTPError(RuntimeError):
    """Raised when a provider returns a non-success response or invalid SSE."""


class SSETransport(Protocol):
    def stream_sse(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        json_body: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]: ...


class HttpxSSETransport:
    """Production SSE transport; tests inject an in-memory implementation."""

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
                        body = (await response.aread()).decode(errors="replace")
                        raise ProviderHTTPError(f"HTTP {response.status_code}: {body[:1000]}")
                    data_lines: list[str] = []
                    async for line in response.aiter_lines():
                        if not line:
                            event = self._decode(data_lines)
                            data_lines.clear()
                            if event is not None:
                                yield event
                            continue
                        if line.startswith("data:"):
                            data_lines.append(line[5:].lstrip())
                    event = self._decode(data_lines)
                    if event is not None:
                        yield event
        except httpx.HTTPError as exception:
            raise ProviderHTTPError(str(exception)) from exception

    @staticmethod
    def _decode(data_lines: list[str]) -> dict[str, Any] | None:
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

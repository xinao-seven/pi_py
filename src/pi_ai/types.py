"""Provider-neutral data contracts owned by the :mod:`pi_ai` layer.

Messages intentionally remain JSON-compatible dictionaries. TypedDict keeps
the pi-style wire format readable without burdening session serialization.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, TypeAlias, TypedDict

JsonObject: TypeAlias = dict[str, Any]
ThinkingLevel: TypeAlias = Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"]
StopReason: TypeAlias = Literal["stop", "length", "toolUse", "error", "aborted"]


class TextContent(TypedDict):
    type: Literal["text"]
    text: str
    textSignature: NotRequired[str]


class ThinkingContent(TypedDict):
    type: Literal["thinking"]
    thinking: str
    thinkingSignature: NotRequired[str]
    redacted: NotRequired[bool]


class ImageContent(TypedDict):
    type: Literal["image"]
    data: str
    mimeType: str


class ToolCall(TypedDict):
    type: Literal["toolCall"]
    id: str
    name: str
    arguments: JsonObject
    thoughtSignature: NotRequired[str]


ContentBlock: TypeAlias = TextContent | ThinkingContent | ImageContent | ToolCall


class Usage(TypedDict, total=False):
    input: int
    output: int
    cacheRead: int
    cacheWrite: int
    reasoning: int
    totalTokens: int


class UserMessage(TypedDict):
    role: Literal["user"]
    content: str | list[TextContent | ImageContent]
    timestamp: NotRequired[int]


class AssistantMessage(TypedDict):
    role: Literal["assistant"]
    content: list[TextContent | ThinkingContent | ToolCall]
    provider: str
    model: str
    stopReason: NotRequired[StopReason]
    usage: NotRequired[Usage]
    errorMessage: NotRequired[str]
    timestamp: NotRequired[int]


class ToolResultMessage(TypedDict):
    role: Literal["toolResult"]
    toolCallId: str
    toolName: str
    content: list[TextContent | ImageContent]
    isError: bool
    timestamp: NotRequired[int]


Message: TypeAlias = UserMessage | AssistantMessage | ToolResultMessage


@dataclass(frozen=True, slots=True)
class Model:
    id: str
    provider: str
    api: str
    context_window: int
    name: str | None = None
    base_url: str | None = None
    reasoning: bool = False
    input: tuple[Literal["text", "image"], ...] = ("text",)
    max_tokens: int = 8192
    headers: JsonObject = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Tool:
    name: str
    description: str
    input_schema: JsonObject

    def provider_definition(self) -> JsonObject:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }

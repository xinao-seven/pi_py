"""Provider-neutral data contracts owned by the :mod:`pi_ai` layer.

Messages intentionally remain JSON-compatible dictionaries. TypedDict keeps
the pi-style wire format readable without burdening session serialization.

中文说明：本模块是 pi_ai 层的数据契约，定义统一的消息、工具与模型原子类型。
消息刻意保持 JSON 兼容的字典结构，TypedDict 让 pi 风格的线上格式保持可读，
同时不会给 Session 序列化带来额外负担。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, TypeAlias, TypedDict

JsonObject: TypeAlias = dict[str, Any]
# 思考强度档位：off 表示关闭，其余由低到高，最终映射到各家 Provider 的 thinking/reasoning 参数
ThinkingLevel: TypeAlias = Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"]
# 模型停止原因：正常结束 / 输出超长 / 请求调用工具 / 出错 / 被中止
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
    """模型发起的工具调用意图；id 用于关联后续同 id 的 toolResult。"""
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
    """统一用户消息：可以是纯文本，也可以是文本+图片内容块列表。"""
    role: Literal["user"]
    content: str | list[TextContent | ImageContent]
    timestamp: NotRequired[int]


class AssistantMessage(TypedDict):
    """统一助手消息：记录来自哪个 provider/model、结束原因与 token 用量。"""
    role: Literal["assistant"]
    content: list[TextContent | ThinkingContent | ToolCall]
    provider: str
    model: str
    stopReason: NotRequired[StopReason]
    usage: NotRequired[Usage]
    errorMessage: NotRequired[str]
    timestamp: NotRequired[int]


class ToolResultMessage(TypedDict):
    """统一工具结果消息：通过 toolCallId 回填到对应的工具调用。"""
    role: Literal["toolResult"]
    toolCallId: str
    toolName: str
    content: list[TextContent | ImageContent]
    isError: bool
    timestamp: NotRequired[int]


Message: TypeAlias = UserMessage | AssistantMessage | ToolResultMessage


@dataclass(frozen=True, slots=True)
class Model:
    """模型元数据：id、所属 provider、API 协议、上下文窗口，以及思考/多模态能力。"""
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
    """工具声明（名称、描述、JSON Schema 入参）；provider_definition 转成厂商需要的格式。"""
    name: str
    description: str
    input_schema: JsonObject

    def provider_definition(self) -> JsonObject:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }

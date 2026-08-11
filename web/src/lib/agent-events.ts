// Agent 事件状态机与消息文本工具：把后端 SSE 事件规约成前端流式状态。
import type { AgentEvent, AgentMessage, AgentStreamState, PendingToolCall } from "@/types";

export const INITIAL_STREAM_STATE: AgentStreamState = {
  running: false,
  phase: "idle",
  streamingMessage: null,
  error: null,
  pendingToolCall: null,
};

export function reduceAgentEvent(
  state: AgentStreamState,
  event: AgentEvent,
): AgentStreamState {
  // 事件 -> 状态的规约函数（纯函数，便于测试）：
  // agent_start 进入等待；message_update 显示流式回复；
  // tool_execution_start 进入工具阶段；tool_call_pending 挂起等待人工确认；
  // tool_execution_end / tool_execution_blocked 回到等待；agent_end 回到空闲。
  switch (event.type) {
    case "agent_start":
      return { ...INITIAL_STREAM_STATE, running: true, phase: "waiting" };
    case "message_update":
      return event.message?.role === "assistant"
        ? { ...state, running: true, phase: "responding", streamingMessage: event.message, pendingToolCall: null }
        : state;
    case "message_end":
      return event.message?.role === "assistant"
        ? { ...state, phase: "waiting", streamingMessage: null }
        : state;
    case "tool_execution_start":
      return { ...state, running: true, phase: "tool", streamingMessage: null, pendingToolCall: null };
    case "tool_call_pending":
      return {
        ...state,
        running: true,
        phase: "tool",
        streamingMessage: null,
        pendingToolCall: {
          toolCallId: String(event.toolCallId ?? ""),
          toolName: String(event.toolName ?? "bash"),
          reason: String(event.reason ?? "危险命令"),
          rule: String(event.rule ?? ""),
          args: (event.args ?? {}) as Record<string, unknown>,
        } satisfies PendingToolCall,
      };
    case "tool_execution_end":
      return { ...state, phase: "waiting", pendingToolCall: null };
    case "tool_execution_blocked":
      return { ...state, phase: "waiting", pendingToolCall: null };
    case "agent_end":
      return {
        running: false,
        phase: "idle",
        streamingMessage: null,
        error: typeof event.error === "string" && event.error ? event.error : null,
        pendingToolCall: null,
      };
    default:
      return state;
  }
}

export function messageText(message: AgentMessage): string {
  // 提取消息的纯文本（拼接全部 text 内容块），用于预览与搜索
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

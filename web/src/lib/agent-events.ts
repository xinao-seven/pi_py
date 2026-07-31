import type { AgentEvent, AgentMessage, AgentStreamState } from "@/types";

export const INITIAL_STREAM_STATE: AgentStreamState = {
  running: false,
  phase: "idle",
  streamingMessage: null,
  error: null,
};

export function reduceAgentEvent(
  state: AgentStreamState,
  event: AgentEvent,
): AgentStreamState {
  switch (event.type) {
    case "agent_start":
      return { running: true, phase: "waiting", streamingMessage: null, error: null };
    case "message_update":
      return event.message?.role === "assistant"
        ? { ...state, running: true, phase: "responding", streamingMessage: event.message }
        : state;
    case "message_end":
      return event.message?.role === "assistant"
        ? { ...state, phase: "waiting", streamingMessage: null }
        : state;
    case "tool_execution_start":
      return { ...state, running: true, phase: "tool", streamingMessage: null };
    case "tool_execution_end":
      return { ...state, phase: "waiting" };
    case "agent_end":
      return {
        running: false,
        phase: "idle",
        streamingMessage: null,
        error: typeof event.error === "string" && event.error ? event.error : null,
      };
    default:
      return state;
  }
}

export function messageText(message: AgentMessage): string {
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

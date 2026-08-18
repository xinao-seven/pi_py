import { INITIAL_STREAM_STATE, messageText, reduceAgentEvent } from "@/lib/agent-events";

describe("reduceAgentEvent", () => {
  it("tracks a streaming assistant response through completion", () => {
    const started = reduceAgentEvent(INITIAL_STREAM_STATE, { type: "agent_start" });
    const streaming = reduceAgentEvent(started, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hel" }],
      },
    });
    const ended = reduceAgentEvent(streaming, { type: "agent_end", error: null });

    expect(streaming.phase).toBe("responding");
    expect(messageText(streaming.streamingMessage!)).toBe("hel");
    expect(ended).toEqual(INITIAL_STREAM_STATE);
  });

  it("preserves a terminal agent error", () => {
    const ended = reduceAgentEvent(INITIAL_STREAM_STATE, {
      type: "agent_end",
      error: "provider unavailable",
    });

    expect(ended.error).toBe("provider unavailable");
    expect(ended.running).toBe(false);
  });

  it("shows a pending tool call until approval is resolved", () => {
    const started = reduceAgentEvent(INITIAL_STREAM_STATE, { type: "agent_start" });
    const pending = reduceAgentEvent(started, {
      type: "tool_call_pending",
      toolCallId: "call-1",
      toolName: "bash",
      reason: "递归/强制删除文件或目录",
      rule: "recursive-delete",
      risk: "critical",
      category: "destructive",
      args: { command: "rm -rf ./build" },
    });

    expect(pending.phase).toBe("tool");
    expect(pending.pendingToolCall).toEqual({
      toolCallId: "call-1",
      toolName: "bash",
      reason: "递归/强制删除文件或目录",
      rule: "recursive-delete",
      risk: "critical",
      category: "destructive",
      args: { command: "rm -rf ./build" },
    });

    const rejected = reduceAgentEvent(pending, {
      type: "tool_execution_blocked",
      toolCallId: "call-1",
    });
    expect(rejected.pendingToolCall).toBeNull();
    expect(rejected.phase).toBe("waiting");
  });

  it("clears pending on execution end and agent end", () => {
    const pending = reduceAgentEvent(INITIAL_STREAM_STATE, {
      type: "tool_call_pending",
      toolCallId: "call-1",
      toolName: "bash",
      reason: "格式化磁盘",
      risk: "critical",
      category: "system",
      args: { command: "format c:" },
    });
    const executed = reduceAgentEvent(pending, {
      type: "tool_execution_end",
      toolCallId: "call-1",
      isError: false,
    });
    expect(executed.pendingToolCall).toBeNull();

    const again = reduceAgentEvent(INITIAL_STREAM_STATE, {
      type: "tool_call_pending",
      toolCallId: "call-2",
      toolName: "bash",
      reason: "关机",
      risk: "critical",
      category: "system",
      args: { command: "shutdown /s" },
    });
    const ended = reduceAgentEvent(again, { type: "agent_end", error: null });
    expect(ended.pendingToolCall).toBeNull();
    expect(ended).toEqual(INITIAL_STREAM_STATE);
  });
});

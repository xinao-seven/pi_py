import { INITIAL_STREAM_STATE, messageText, reduceAgentEvent } from "./agent-events";

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
});

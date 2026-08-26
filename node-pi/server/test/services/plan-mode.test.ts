import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import planModeExtension from "../../extensions/plan-mode.js";
import {
  PLAN_CHANNEL_SET,
  PLAN_CHANNEL_STATE,
  PlanModeService,
} from "../../src/services/plan-mode-service.js";

function makeFakePi(events: ReturnType<typeof createEventBus>) {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  return {
    events,
    handlers,
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => ["read", "bash", "edit", "write"]),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on(name: string, handler: (event: any, ctx?: any) => any) { handlers.set(name, handler); },
  };
}

function sessionContext() {
  return {
    sessionManager: {
      getSessionId: () => "session-1",
      getEntries: () => [],
    },
  };
}

describe("PlanModeService", () => {
  it("keeps extension state and REST command channel in sync", () => {
    const events = createEventBus();
    const service = new PlanModeService(events);
    const received = vi.fn();
    const off = events.on(PLAN_CHANNEL_SET, received);

    events.emit(PLAN_CHANNEL_STATE, {
      sessionId: "session-1",
      mode: "planning",
      todos: [{ step: 1, text: "Inspect the repository", completed: false }],
      awaitingConfirmation: true,
    });

    expect(service.state("session-1")).toMatchObject({ mode: "planning", awaitingConfirmation: true });
    service.command("session-1", "refine", "Use the existing REST conventions");
    expect(received).toHaveBeenCalledWith({
      sessionId: "session-1",
      action: "refine",
      message: "Use the existing REST conventions",
    });
    expect(() => service.command("session-1", "execute")).not.toThrow();
    expect(() => service.command("session-2", "execute")).toThrow(/awaiting confirmation/);

    off();
    service.dispose();
  });
});

describe("web plan-mode extension", () => {
  it("enforces read-only planning, parses a Plan, then advances execution from DONE markers", () => {
    const events = createEventBus();
    const pi = makeFakePi(events);
    const snapshots: any[] = [];
    events.on(PLAN_CHANNEL_STATE, (value) => snapshots.push(value));
    planModeExtension(pi as never);

    pi.handlers.get("session_start")!({}, sessionContext());
    events.emit(PLAN_CHANNEL_SET, { sessionId: "session-1", action: "enable" });
    expect(pi.setActiveTools).toHaveBeenLastCalledWith(expect.not.arrayContaining(["edit", "write"]));

    const blocked = pi.handlers.get("tool_call")!({ toolName: "bash", input: { command: "rm -rf ./dist" } });
    expect(blocked).toMatchObject({ block: true });
    expect(pi.handlers.get("tool_call")!({ toolName: "bash", input: { command: "rg Plan src" } })).toBeUndefined();
    expect(pi.handlers.get("before_agent_start")!()).toMatchObject({ message: { customType: "web-plan-context" } });

    pi.handlers.get("agent_end")!({
      messages: [{ role: "assistant", content: [{ type: "text", text: "## Plan:\n1. Inspect the backend protocol\n2. Implement the API\n" }] }],
    });
    expect(snapshots.at(-1)).toMatchObject({ mode: "planning", awaitingConfirmation: true, todos: [{ step: 1 }, { step: 2 }] });

    events.emit(PLAN_CHANNEL_SET, { sessionId: "session-1", action: "execute" });
    expect(snapshots.at(-1)).toMatchObject({ mode: "executing", awaitingConfirmation: false });
    expect(pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "edit", "write"]);
    expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "web-plan-execute" }), expect.objectContaining({ triggerTurn: true }));

    pi.handlers.get("turn_end")!({ message: { role: "assistant", content: [{ type: "text", text: "API has been verified. [DONE:1]" }] } });
    expect(snapshots.at(-1)).toMatchObject({ mode: "executing", todos: [{ step: 1, completed: true }, { step: 2, completed: false }] });
  });

  it("blocks MCP tools during planning and allows them after disable", () => {
    const events = createEventBus();
    const pi = makeFakePi(events);
    planModeExtension(pi as never);

    pi.handlers.get("session_start")!({}, sessionContext());
    events.emit(PLAN_CHANNEL_SET, { sessionId: "session-1", action: "enable" });

    const mcpTool = { toolName: "mcp__github__create_issue", input: { title: "x" } };
    expect(pi.handlers.get("tool_call")!(mcpTool)).toMatchObject({ block: true });

    events.emit(PLAN_CHANNEL_SET, { sessionId: "session-1", action: "disable" });
    expect(pi.handlers.get("tool_call")!(mcpTool)).toBeUndefined();
  });

  it("parses bullet/Chinese plans and finds the plan on a non-final assistant message", () => {
    const events = createEventBus();
    const pi = makeFakePi(events);
    const snapshots: any[] = [];
    events.on(PLAN_CHANNEL_STATE, (value) => snapshots.push(value));
    planModeExtension(pi as never);

    pi.handlers.get("session_start")!({}, sessionContext());
    events.emit(PLAN_CHANNEL_SET, { sessionId: "session-1", action: "enable" });

    pi.handlers.get("agent_end")!({
      messages: [
        { role: "user", content: [{ type: "text", text: "请实现登录" }] },
        { role: "assistant", content: [{ type: "text", text: "## 计划\n- 设计 API\n- 实现路由\n- 联调验证" }] },
        { role: "assistant", content: [{ type: "text", text: "以上就是完整方案，请确认。" }] },
      ],
    });
    expect(snapshots.at(-1)).toMatchObject({ mode: "planning", awaitingConfirmation: true, todos: [{ step: 1, text: "设计 API" }, { step: 2, text: "实现路由" }, { step: 3, text: "联调验证" }] });
  });
});

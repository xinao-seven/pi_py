import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHANNEL_ABORTED,
  CHANNEL_DECIDE,
  CHANNEL_PENDING,
  ToolApprovalBroker,
} from "../../src/services/tool-approval.js";
import {
  CHANNEL_ABORTED as ExtAborted,
  CHANNEL_DECIDE as ExtDecide,
  CHANNEL_PENDING as ExtPending,
  createApprovalExtension,
  classifyBashCommand,
  findDangerousBashRule,
} from "../../extensions/tool-approval.js";

/** 事件总线版 broker：直接用同一个 createEventBus() 构造，并在测试后 dispose 掉未结算的定时器。 */
const brokers: ToolApprovalBroker[] = [];
function makeBroker(timeoutMs = 5_000) {
  const events = createEventBus();
  const broker = new ToolApprovalBroker(events, { timeoutMs });
  brokers.push(broker);
  return { events, broker };
}

afterEach(() => {
  while (brokers.length) brokers.pop()!.dispose();
});

/** 构造一个带事件总线 + tool_call 处理器捕获的假 Pi（用于端到端测试扩展）。 */
function makeFakePi(events: ReturnType<typeof createEventBus>) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  return {
    events,
    handlers,
    on(channel: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(channel, handler);
    },
    async runToolCall(event: unknown, ctx: unknown) {
      const handler = handlers.get("tool_call");
      if (!handler) throw new Error("no tool_call handler registered");
      return handler(event, ctx);
    },
  };
}

/** 构造 tool_call 的上下文：hasUI=false 表示 Web 后端，true 表示 TUI/RPC。 */
function makeCtx(hasUI = false) {
  return {
    hasUI,
    sessionManager: { getSessionId: () => "session-1" },
    signal: undefined as AbortSignal | undefined,
  };
}

/** 一条待审批项（与扩展/后端约定的载荷结构）。 */
function pendingCall(sessionId: string, toolCallId: string) {
  return {
    sessionId,
    toolCallId,
    toolName: "bash",
    args: { command: "rm -rf ./build" },
    reason: "递归或强制删除文件/目录，可能造成不可恢复的数据丢失",
    rule: "recursive-delete",
    risk: "critical",
    category: "destructive",
  };
}

describe("event channel contract", () => {
  it("keeps server and extension channel names in sync", () => {
    expect(ExtPending).toBe(CHANNEL_PENDING);
    expect(ExtDecide).toBe(CHANNEL_DECIDE);
    expect(ExtAborted).toBe(CHANNEL_ABORTED);
  });
});

describe("dangerous command rules", () => {
  it("does not require approval for read-only shell inspection", () => {
    for (const command of ["find . -maxdepth 2 -type f", "ls -la", "git log --oneline -5"]) {
      expect(findDangerousBashRule({ command })).toBeUndefined();
    }
  });

  it("recognizes destructive shell commands that require approval", () => {
    const rule = findDangerousBashRule({ command: "rm -rf ./build" });

    expect(rule).toMatchObject({ name: "recursive-delete" });
  });

  it("requires approval before deleting even a single file", () => {
    const rule = findDangerousBashRule({ command: "rm ./notes.txt" });

    expect(rule).toMatchObject({ name: "file-delete" });
  });

  it("classifies destructive commands as critical with an impact category", () => {
    expect(classifyBashCommand({ command: "rm -rf ./build" })).toMatchObject({
      rule: "recursive-delete",
      risk: "critical",
      category: "destructive",
    });
  });

  it("requires approval for dependency, network, and remote Git side effects", () => {
    expect(classifyBashCommand({ command: "npm install fastify" })).toMatchObject({
      rule: "dependency-change",
      risk: "high",
      category: "dependency_change",
    });
    expect(classifyBashCommand({ command: "curl https://example.com" })).toMatchObject({
      rule: "network-request",
      risk: "medium",
      category: "network",
    });
    expect(classifyBashCommand({ command: "git push origin main" })).toMatchObject({
      rule: "git-remote-write",
      risk: "high",
      category: "git_remote",
    });
  });
});

describe("ToolApprovalBroker (event bus)", () => {
  it("records a pending call published by the extension and notifies its listener", () => {
    const { events, broker } = makeBroker();
    const listener = vi.fn();
    broker.setPendingListener(listener);

    events.emit(CHANNEL_PENDING, pendingCall("session-1", "call-1"));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(broker.pendingForSession("session-1")).toMatchObject({
      toolCallId: "call-1",
      rule: "recursive-delete",
      risk: "critical",
      category: "destructive",
    });
  });

  it("decide() rejects unknown call ids and emits a decision for known ones", () => {
    const { events, broker } = makeBroker();
    const onDecide = vi.fn();
    const off = events.on(CHANNEL_DECIDE, (data) => onDecide(data));

    events.emit(CHANNEL_PENDING, pendingCall("session-1", "call-1"));

    expect(() => broker.decide("session-1", "missing", true)).toThrow(/no longer pending/);
    broker.decide("session-1", "call-1", true);
    expect(onDecide).toHaveBeenCalledWith({ sessionId: "session-1", toolCallId: "call-1", approved: true });
    off();
  });

  it("clears the pending snapshot once a call is settled", () => {
    const { events, broker } = makeBroker();
    events.emit(CHANNEL_PENDING, pendingCall("session-1", "call-1"));
    expect(broker.pendingForSession("session-1")).toBeDefined();

    broker.decide("session-1", "call-1", true);

    expect(broker.pendingForSession("session-1")).toBeUndefined();
  });

  it("rejects by default when the decision timeout expires", async () => {
    const { events, broker } = makeBroker(10);
    const onDecide = vi.fn();
    const off = events.on(CHANNEL_DECIDE, (data) => onDecide(data));

    events.emit(CHANNEL_PENDING, pendingCall("session-1", "call-1"));

    await vi.waitFor(() => {
      expect(onDecide).toHaveBeenCalledWith({ sessionId: "session-1", toolCallId: "call-1", approved: false });
      expect(broker.pendingForSession("session-1")).toBeUndefined();
    });
    off();
  });

  it("cancelSession() rejects all pending calls of that session", () => {
    const { events, broker } = makeBroker();
    const onDecide = vi.fn();
    const off = events.on(CHANNEL_DECIDE, (data) => onDecide(data));

    events.emit(CHANNEL_PENDING, pendingCall("session-1", "call-1"));
    events.emit(CHANNEL_PENDING, pendingCall("session-1", "call-2"));
    events.emit(CHANNEL_PENDING, pendingCall("session-2", "call-3"));

    broker.cancelSession("session-1");

    expect(broker.pendingForSession("session-1")).toBeUndefined();
    expect(broker.pendingForSession("session-2")).toBeDefined();
    expect(onDecide).toHaveBeenCalledWith({ sessionId: "session-1", toolCallId: "call-1", approved: false });
    expect(onDecide).toHaveBeenCalledWith({ sessionId: "session-1", toolCallId: "call-2", approved: false });
    expect(onDecide).not.toHaveBeenCalledWith({ sessionId: "session-2", toolCallId: "call-3", approved: false });
    off();
  });

  it("settles the pending call as rejected when the extension reports an abort", () => {
    const { events, broker } = makeBroker();
    const onDecide = vi.fn();
    const off = events.on(CHANNEL_DECIDE, (data) => onDecide(data));

    events.emit(CHANNEL_PENDING, pendingCall("session-1", "call-1"));
    events.emit(CHANNEL_ABORTED, { sessionId: "session-1", toolCallId: "call-1" });

    expect(broker.pendingForSession("session-1")).toBeUndefined();
    expect(onDecide).toHaveBeenCalledWith({ sessionId: "session-1", toolCallId: "call-1", approved: false });
    off();
  });

  it("dispose() unsubscribes from the bus and settles remaining pendings", () => {
    const { events, broker } = makeBroker();
    const listener = vi.fn();
    broker.setPendingListener(listener);

    events.emit(CHANNEL_PENDING, pendingCall("session-1", "call-1"));
    expect(broker.pendingForSession("session-1")).toBeDefined();

    broker.dispose();

    // 退订后不再响应新事件。
    events.emit(CHANNEL_PENDING, pendingCall("session-2", "call-2"));
    expect(listener).toHaveBeenCalledTimes(1);
    // 已挂起的被结算清空。
    expect(broker.pendingForSession("session-1")).toBeUndefined();
  });
});

describe("approval extension end-to-end", () => {
  it("approves a dangerous bash call when the broker decides true", async () => {
    const { events, broker } = makeBroker();
    const pi = makeFakePi(events);
    createApprovalExtension()(pi as never);
    const ctx = makeCtx();

    const result = pi.runToolCall(
      { toolName: "bash", toolCallId: "call-1", input: { command: "rm -rf ./build" } },
      ctx,
    );

    expect(broker.pendingForSession("session-1")).toMatchObject({
      toolCallId: "call-1",
      rule: "recursive-delete",
      risk: "critical",
      category: "destructive",
    });
    broker.decide("session-1", "call-1", true);
    await expect(result).resolves.toBeUndefined();
    expect(broker.pendingForSession("session-1")).toBeUndefined();
  });

  it("blocks a dangerous bash call when the broker decides false", async () => {
    const { events, broker } = makeBroker();
    const pi = makeFakePi(events);
    createApprovalExtension()(pi as never);
    const ctx = makeCtx();

    const result = pi.runToolCall(
      { toolName: "bash", toolCallId: "call-2", input: { command: "shutdown /s" } },
      ctx,
    );

    broker.decide("session-1", "call-2", false);
    await expect(result).resolves.toEqual({ block: true, reason: "Tool execution was not approved" });
  });

  it("blocks by default when the broker decision timeout expires", async () => {
    const { events, broker } = makeBroker(10);
    const pi = makeFakePi(events);
    createApprovalExtension()(pi as never);
    const ctx = makeCtx();

    const result = pi.runToolCall(
      { toolName: "bash", toolCallId: "call-3", input: { command: "rm ./notes.txt" } },
      ctx,
    );

    await expect(result).resolves.toEqual({ block: true, reason: "Tool execution was not approved" });
    expect(broker.pendingForSession("session-1")).toBeUndefined();
  });

  it("blocks pending calls when the session is cancelled", async () => {
    const { events, broker } = makeBroker();
    const pi = makeFakePi(events);
    createApprovalExtension()(pi as never);
    const ctx = makeCtx();

    const result = pi.runToolCall(
      { toolName: "bash", toolCallId: "call-4", input: { command: "git push --force origin main" } },
      ctx,
    );

    broker.cancelSession("session-1");
    await expect(result).resolves.toEqual({ block: true, reason: "Tool execution was not approved" });
  });

  it("blocks when the call is aborted via AbortSignal", async () => {
    const { events, broker } = makeBroker();
    const pi = makeFakePi(events);
    createApprovalExtension()(pi as never);
    const controller = new AbortController();
    const ctx = makeCtx();
    ctx.signal = controller.signal;

    const result = pi.runToolCall(
      { toolName: "bash", toolCallId: "call-8", input: { command: "rm ./notes.txt" } },
      ctx,
    );

    controller.abort();
    await expect(result).resolves.toEqual({ block: true, reason: "Tool execution was not approved" });
    expect(broker.pendingForSession("session-1")).toBeUndefined();
  });

  it("does not intercept non-bash tools or safe bash commands", async () => {
    const { events, broker } = makeBroker();
    const pi = makeFakePi(events);
    createApprovalExtension()(pi as never);
    const ctx = makeCtx();

    await expect(
      pi.runToolCall({ toolName: "read", toolCallId: "call-5", input: { filePath: "a.txt" } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      pi.runToolCall({ toolName: "bash", toolCallId: "call-6", input: { command: "ls -la" } }, ctx),
    ).resolves.toBeUndefined();
    expect(broker.pendingForSession("session-1")).toBeUndefined();
  });

  it("does not intercept dangerous bash in TUI/RPC (hasUI=true), which have their own confirm UI", async () => {
    const { events, broker } = makeBroker();
    const pi = makeFakePi(events);
    createApprovalExtension()(pi as never);

    const result = pi.runToolCall(
      { toolName: "bash", toolCallId: "call-7", input: { command: "rm -rf ./build" } },
      makeCtx(true),
    );

    await expect(result).resolves.toBeUndefined();
    expect(broker.pendingForSession("session-1")).toBeUndefined();
  });
});

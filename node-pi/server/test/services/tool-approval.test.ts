import { describe, expect, it, vi } from "vitest";

import { findDangerousBashRule, ToolApprovalBroker } from "../../src/services/tool-approval.js";

describe("ToolApprovalBroker", () => {
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

  it("publishes a pending call and resolves only its matching decision", async () => {
    const broker = new ToolApprovalBroker();
    const listener = vi.fn();
    broker.setPendingListener(listener);
    const waiting = broker.wait({
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "rm -rf ./build" },
      reason: "递归或强制删除文件/目录，可能造成不可恢复的数据丢失",
      rule: "recursive-delete",
    }, undefined);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(broker.pendingForSession("session-1")).toMatchObject({ toolCallId: "call-1", rule: "recursive-delete" });
    expect(() => broker.decide("session-1", "missing", true)).toThrow(/no longer pending/);
    broker.decide("session-1", "call-1", true);
    await expect(waiting).resolves.toBe(true);
  });

  it("rejects pending approvals when a session is cancelled", async () => {
    const broker = new ToolApprovalBroker();
    const waiting = broker.wait({
      sessionId: "session-1",
      toolCallId: "call-2",
      toolName: "bash",
      args: { command: "shutdown /s" },
      reason: "关机、重启或断电会中断当前机器",
      rule: "shutdown",
    }, undefined);
    broker.cancelSession("session-1");
    await expect(waiting).resolves.toBe(false);
  });
});

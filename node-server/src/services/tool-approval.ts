import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { ApiError } from "../errors.js";

export interface PendingToolApproval {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  rule: string;
}

export interface DangerousCommandRule {
  name: string;
  pattern: RegExp;
  reason: string;
}

/**
 * Commands that can irreversibly affect the host or remote history.
 *
 * Read-only inspection commands such as `find`, `ls`, and `git log` are never
 * matched and therefore run without interrupting the agent.  The rules mirror
 * the Python learning backend so both backends have the same approval policy.
 */
export const DANGEROUS_COMMAND_RULES: readonly DangerousCommandRule[] = [
  {
    name: "privileged-delete",
    pattern: /sudo\s+.*\b(rm|del|remove-item)\b/i,
    reason: "使用提权执行删除命令，影响范围可能超出当前工作区",
  },
  {
    name: "recursive-delete",
    pattern: /(^|\b)(rm|rmdir|rd|del|remove-item)(\s|\/).*(-rf|-fr|--recursive|-recurse|\/s)(\s|$)/i,
    reason: "递归或强制删除文件/目录，可能造成不可恢复的数据丢失",
  },
  {
    name: "file-delete",
    pattern: /(^|[;|&]\s*|\b(?:sudo|command|xargs)\s+)(rm|rmdir|rd|del|remove-item)(\s|$)/i,
    reason: "删除文件或目录会改变工作区内容，需要人工确认",
  },
  {
    name: "force-delete",
    pattern: /(^|\b)remove-item(\s|\/).*(-force|\/f)(\s|$)/i,
    reason: "强制删除文件或目录，可能造成不可恢复的数据丢失",
  },
  {
    name: "disk-format",
    pattern: /(^|\b)(format|format-volume|mkfs|mkfs\.[a-z0-9]+|fdisk|diskpart)([.\s]|$)/i,
    reason: "磁盘格式化或分区操作会销毁磁盘数据",
  },
  {
    name: "raw-disk-write",
    pattern: /(^|\b)dd(\s+.*)?\s+of=\/(dev\/(sd|hd)|dev)\b|>\s*\/dev\/(sd|hd)/i,
    reason: "直接写入磁盘设备会覆盖磁盘内容",
  },
  {
    name: "shutdown",
    pattern: /(^|\b)(shutdown|restart-computer|stop-computer|reboot|poweroff)(\s|$)/i,
    reason: "关机、重启或断电会中断当前机器",
  },
  {
    name: "force-push",
    pattern: /git\s+(push|fetch)\s+.*(-f|--force)\b/i,
    reason: "强制推送或拉取 Git 历史，可能覆盖远端提交",
  },
  {
    name: "bulk-uninstall",
    pattern: /(^|\b)(pip|npm|conda|apt|apt-get|dnf|yum)\s+(uninstall|remove|purge)(\s|$).*(-y\b|--yes\b|-y$)/i,
    reason: "批量卸载软件包，可能破坏开发环境",
  },
  {
    name: "pipe-remote-script",
    pattern: /(curl|wget|iwr|invoke-webrequest|invoke-restmethod)[^\n|]*\s*\|\s*(sh|bash|zsh|iex|powershell)/i,
    reason: "将远程脚本直接管道执行，可能运行未知代码",
  },
  {
    name: "recursive-chmod",
    pattern: /chmod\s+(-r\s+)?777\s+\/\s*$|chown\s+(-r\s+)?[^\s]+\s+\//i,
    reason: "递归修改根目录权限或属主，可能使系统不可用",
  },
  {
    name: "registry-delete",
    pattern: /(^|\b)reg\s+delete\b/i,
    reason: "删除 Windows 注册表项，可能损坏系统配置",
  },
  {
    name: "fork-bomb",
    pattern: /:\(\)\s*\{.*\|.*&.*\}/,
    reason: "fork 炸弹会使系统资源耗尽",
  },
];

export function findDangerousBashRule(input: unknown): DangerousCommandRule | undefined {
  if (!input || typeof input !== "object" || typeof (input as { command?: unknown }).command !== "string") return undefined;
  const command = (input as { command: string }).command.trim().replace(/\s+/g, " ");
  return DANGEROUS_COMMAND_RULES.find((rule) => rule.pattern.test(command));
}

interface Waiter {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  pending: PendingToolApproval;
}

/** In-memory, one-shot approvals for original Pi tool_call extension hooks. */
export class ToolApprovalBroker {
  private readonly waiting = new Map<string, Waiter>();
  private onPending: ((pending: PendingToolApproval) => void) | undefined;

  setPendingListener(listener: (pending: PendingToolApproval) => void): void { this.onPending = listener; }

  wait(pending: PendingToolApproval, signal: AbortSignal | undefined): Promise<boolean> {
    const key = this.key(pending.sessionId, pending.toolCallId);
    if (this.waiting.has(key)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (approved: boolean) => {
        const current = this.waiting.get(key);
        if (!current) return;
        clearTimeout(current.timer);
        this.waiting.delete(key);
        signal?.removeEventListener("abort", reject);
        resolve(approved);
      };
      const reject = () => finish(false);
      const timer = setTimeout(reject, 30_000);
      this.waiting.set(key, { resolve: finish, timer, pending });
      signal?.addEventListener("abort", reject, { once: true });
      this.onPending?.(pending);
    });
  }

  decide(sessionId: string, toolCallId: string, approved: boolean): void {
    const waiter = this.waiting.get(this.key(sessionId, toolCallId));
    if (!waiter) throw new ApiError(404, "approval_not_found", "Tool approval is no longer pending");
    waiter.resolve(approved);
  }

  cancelSession(sessionId: string): void {
    for (const [key, waiter] of this.waiting) {
      if (key.startsWith(`${sessionId}:`)) waiter.resolve(false);
    }
  }

  pendingForSession(sessionId: string): PendingToolApproval | undefined {
    for (const [key, waiter] of this.waiting) {
      if (key.startsWith(`${sessionId}:`)) return waiter.pending;
    }
    return undefined;
  }

  private key(sessionId: string, toolCallId: string): string { return `${sessionId}:${toolCallId}`; }
}

export function createApprovalExtension(broker: ToolApprovalBroker): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash") return undefined;
      const rule = findDangerousBashRule(event.input);
      if (!rule) return undefined;
      const approved = await broker.wait({
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input as Record<string, unknown>,
        reason: rule.reason,
        rule: rule.name,
      }, ctx.signal);
      return approved ? undefined : { block: true, reason: "Tool execution was not approved" };
    });
  };
}

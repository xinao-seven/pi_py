/**
 * 工具调用审批：危险命令识别 + 审批中枢 + Pi 扩展桥。
 *
 * 中文说明：Pi 的 bash 工具可以执行任意命令。Web 前端没有 Pi 终端的确认 UI，
 * 所以本模块做了三层配合：
 * 1. DANGEROUS_COMMAND_RULES：一组"危险命令"正则规则（删除/格式化/关机/
 *    强推 git 等不可逆操作），规则与 Python 学习后端保持一致，保证两个后端
 *    的审批策略相同；
 * 2. ToolApprovalBroker：内存中的"一次性审批"中枢——命令命中规则后，工具调用
 *    在这里挂起等待（默认 30 秒超时拒绝），同时通过 pending 监听器把事件推给
 *    SSE 流，前端弹出审批对话框后调用 approve_tool 命令给出结果；
 * 3. createApprovalExtension：把中枢桥接进 Pi SDK 的扩展系统（tool_call 钩子），
 *    命中规则时拦截工具执行，等待审批结果。
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { ApiError } from "../errors.js";

/** 一条待审批的工具调用（会通过 SSE 事件推给前端）。 */
export interface PendingToolApproval {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string; // 人类可读的危险原因
  rule: string;   // 命中的规则名
}

/** 危险命令规则：名称 + 正则 + 原因说明。 */
export interface DangerousCommandRule {
  name: string;
  pattern: RegExp;
  reason: string;
}

/**
 * 会不可逆地影响宿主机或远端历史的命令。
 *
 * 只读检查类命令（find / ls / git log 等）永远不匹配、不会被打断。
 * 规则与 Python 学习后端保持一致，两个后端执行相同的审批策略。
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

/**
 * 从工具调用输入里找出命中的危险命令规则（没有则返回 undefined = 放行）。
 * 中文说明：输入先规范化（去首尾空白、压缩连续空白），再逐一测试规则正则。
 */
export function findDangerousBashRule(input: unknown): DangerousCommandRule | undefined {
  if (!input || typeof input !== "object" || typeof (input as { command?: unknown }).command !== "string") return undefined;
  const command = (input as { command: string }).command.trim().replace(/\s+/g, " ");
  return DANGEROUS_COMMAND_RULES.find((rule) => rule.pattern.test(command));
}

/** 一个正在等待审批的挂起项（内部用）。 */
interface Waiter {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  pending: PendingToolApproval;
}

/**
 * 内存中的一次性审批中枢。
 * 中文说明：键是 "sessionId:toolCallId"；wait() 挂起等待，decide() 给出结论；
 * 超时（30 秒）或 AbortSignal 触发时按"拒绝"处理。不依赖 Fastify/SSE，
 * 便于单元测试。
 */
export class ToolApprovalBroker {
  private readonly waiting = new Map<string, Waiter>();
  private onPending: ((pending: PendingToolApproval) => void) | undefined;

  /** 注册"有新待审批项"的监听器（注册表用它发 SSE 事件）。 */
  setPendingListener(listener: (pending: PendingToolApproval) => void): void { this.onPending = listener; }

  /**
   * 挂起等待审批结果。
   * @returns Promise<boolean>：true = 放行，false = 拒绝
   * 中文说明：同一 (session, toolCall) 重复调用会直接返回 false（防重入）。
   */
  wait(pending: PendingToolApproval, signal: AbortSignal | undefined): Promise<boolean> {
    const key = this.key(pending.sessionId, pending.toolCallId);
    if (this.waiting.has(key)) return Promise.resolve(false);
    return new Promise((resolve) => {
      // finish：无论批准/拒绝/超时/中断都走这里，负责清理定时器与监听。
      const finish = (approved: boolean) => {
        const current = this.waiting.get(key);
        if (!current) return;
        clearTimeout(current.timer);
        this.waiting.delete(key);
        signal?.removeEventListener("abort", reject);
        resolve(approved);
      };
      const reject = () => finish(false);
      // 30 秒内前端未审批 → 自动拒绝（安全默认）。
      const timer = setTimeout(reject, 30_000);
      this.waiting.set(key, { resolve: finish, timer, pending });
      // 会话被中止/关闭时也会触发 abort → 拒绝。
      signal?.addEventListener("abort", reject, { once: true });
      this.onPending?.(pending); // 通知外部（SSE 发布 tool_call_pending）
    });
  }

  /** 前端给出审批结论（approve_tool 命令的底层实现）。 */
  decide(sessionId: string, toolCallId: string, approved: boolean): void {
    const waiter = this.waiting.get(this.key(sessionId, toolCallId));
    if (!waiter) throw new ApiError(404, "approval_not_found", "Tool approval is no longer pending");
    waiter.resolve(approved);
  }

  /** 会话关闭/删除时，把所有该会话的待审批项按"拒绝"结算。 */
  cancelSession(sessionId: string): void {
    for (const [key, waiter] of this.waiting) {
      if (key.startsWith(`${sessionId}:`)) waiter.resolve(false);
    }
  }

  /** 查询某会话当前是否有待审批项（供状态快照展示 pendingToolCall）。 */
  pendingForSession(sessionId: string): PendingToolApproval | undefined {
    for (const [key, waiter] of this.waiting) {
      if (key.startsWith(`${sessionId}:`)) return waiter.pending;
    }
    return undefined;
  }

  /** 审批项的唯一键：sessionId:toolCallId。 */
  private key(sessionId: string, toolCallId: string): string { return `${sessionId}:${toolCallId}`; }
}

/**
 * 把审批中枢桥接进 Pi SDK 的扩展系统。
 * 中文说明：注册到 DefaultResourceLoader 的 extensionFactories 里（见
 * agent-registry.ts 的 loader()）。Pi 每次调用 bash 工具前会触发
 * "tool_call" 钩子；命中危险规则时这里等待审批：
 * - 批准 → 返回 undefined（放行，工具正常执行）；
 * - 拒绝/超时/中止 → 返回 { block: true, reason }（拦截执行）。
 */
export function createApprovalExtension(broker: ToolApprovalBroker): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      // 只拦截 bash 工具；其他工具（读文件等）直接放行。
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

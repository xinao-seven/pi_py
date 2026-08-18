/**
 * 工具调用审批扩展。
 *
 * 本文件只决定 Bash 调用是否需要 Web 用户确认，并在 Pi 事件总线中等待决定；待审批
 * 队列、超时和 SSE 转发属于 services/tool-approval.ts。两边通过下方常量通信，不能
 * 直接互相 import（扩展由 jiti 隔离加载）。
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const CHANNEL_PENDING = "pi:tool_approval:pending";
export const CHANNEL_DECIDE = "pi:tool_approval:decide";
export const CHANNEL_ABORTED = "pi:tool_approval:aborted";
export type ApprovalRisk = "medium" | "high" | "critical";
export type ApprovalCategory = "workspace_write" | "dependency_change" | "network" | "git_remote" | "destructive" | "system";
export interface PendingToolApproval { sessionId: string; toolCallId: string; toolName: string; args: Record<string, unknown>; reason: string; rule: string; risk: ApprovalRisk; category: ApprovalCategory; }
export interface CommandApproval { rule: string; reason: string; risk: ApprovalRisk; category: ApprovalCategory; }
interface DangerousCommandRule { name: string; pattern: RegExp; reason: string; }
interface SensitiveCommandRule extends CommandApproval { pattern: RegExp; }

/** 高危规则优先，避免强制推送等操作被普通 Git 规则降级。 */
export const DANGEROUS_COMMAND_RULES: readonly DangerousCommandRule[] = [
  { name: "privileged-delete", pattern: /sudo\s+.*\b(rm|del|remove-item)\b/i, reason: "使用提权执行删除命令，影响范围可能超出当前工作区" },
  { name: "recursive-delete", pattern: /(^|\b)(rm|rmdir|rd|del|remove-item)(\s|\/).*(-rf|-fr|--recursive|-recurse|\/s)(\s|$)/i, reason: "递归或强制删除文件/目录，可能造成不可恢复的数据丢失" },
  { name: "file-delete", pattern: /(^|[;|&]\s*|\b(?:sudo|command|xargs)\s+)(rm|rmdir|rd|del|remove-item)(\s|$)/i, reason: "删除文件或目录会改变工作区内容，需要人工确认" },
  { name: "force-delete", pattern: /(^|\b)remove-item(\s|\/).*(-force|\/f)(\s|$)/i, reason: "强制删除文件或目录，可能造成不可恢复的数据丢失" },
  { name: "disk-format", pattern: /(^|\b)(format|format-volume|mkfs|mkfs\.[a-z0-9]+|fdisk|diskpart)([.\s]|$)/i, reason: "磁盘格式化或分区操作会销毁磁盘数据" },
  { name: "raw-disk-write", pattern: /(^|\b)dd(\s+.*)?\s+of=\/(dev\/(sd|hd)|dev)\b|>\s*\/dev\/(sd|hd)/i, reason: "直接写入磁盘设备会覆盖磁盘内容" },
  { name: "shutdown", pattern: /(^|\b)(shutdown|restart-computer|stop-computer|reboot|poweroff)(\s|$)/i, reason: "关机、重启或断电会中断当前机器" },
  { name: "force-push", pattern: /git\s+(push|fetch)\s+.*(-f|--force)\b/i, reason: "强制推送或拉取 Git 历史，可能覆盖远端提交" },
  { name: "bulk-uninstall", pattern: /(^|\b)(pip|npm|conda|apt|apt-get|dnf|yum)\s+(uninstall|remove|purge)(\s|$).*(-y\b|--yes\b|-y$)/i, reason: "批量卸载软件包，可能破坏开发环境" },
  { name: "pipe-remote-script", pattern: /(curl|wget|iwr|invoke-webrequest|invoke-restmethod)[^\n|]*\s*\|\s*(sh|bash|zsh|iex|powershell)/i, reason: "将远程脚本直接管道执行，可能运行未知代码" },
  { name: "recursive-chmod", pattern: /chmod\s+(-r\s+)?777\s+\/\s*$|chown\s+(-r\s+)?[^\s]+\s+\//i, reason: "递归修改根目录权限或属主，可能使系统不可用" },
  { name: "registry-delete", pattern: /(^|\b)reg\s+delete\b/i, reason: "删除 Windows 注册表项，可能损坏系统配置" },
  { name: "fork-bomb", pattern: /:\(\)\s*\{.*\|.*&.*\}/, reason: "fork 炸弹会使系统资源耗尽" },
];
export const SENSITIVE_COMMAND_RULES: readonly SensitiveCommandRule[] = [
  { rule: "git-remote-write", pattern: /\bgit\s+(push|fetch)\b/i, reason: "Git 远端操作可能写入远端分支或改变本地远端跟踪状态", risk: "high", category: "git_remote" },
  { rule: "dependency-change", pattern: /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv)\s+(?:install|add|update|upgrade|remove|uninstall|publish)\b/i, reason: "安装、更新、卸载或发布依赖会改变项目环境或向外部发布内容", risk: "high", category: "dependency_change" },
  { rule: "network-request", pattern: /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b/i, reason: "命令将访问网络；请确认目标和传输的数据符合预期", risk: "medium", category: "network" },
  { rule: "shell-redirection-write", pattern: /(?:^|\s)(?:>|>>)|\b(?:tee|out-file|set-content|add-content)\b/i, reason: "Shell 重定向会直接写入文件，可能覆盖或追加工作区内容", risk: "medium", category: "workspace_write" },
];
export function findDangerousBashRule(input: unknown): DangerousCommandRule | undefined {
  if (!input || typeof input !== "object" || typeof (input as { command?: unknown }).command !== "string") return undefined;
  const command = (input as { command: string }).command.trim().replace(/\s+/g, " ");
  return DANGEROUS_COMMAND_RULES.find((rule) => rule.pattern.test(command));
}
function dangerousCategory(name: string): ApprovalCategory {
  if (name === "force-push") return "git_remote";
  if (name === "pipe-remote-script") return "network";
  return ["shutdown", "disk-format", "raw-disk-write", "registry-delete", "recursive-chmod", "fork-bomb"].includes(name) ? "system" : "destructive";
}
export function classifyBashCommand(input: unknown): CommandApproval | undefined {
  const dangerous = findDangerousBashRule(input);
  if (dangerous) return { rule: dangerous.name, reason: dangerous.reason, risk: "critical", category: dangerousCategory(dangerous.name) };
  if (!input || typeof input !== "object" || typeof (input as { command?: unknown }).command !== "string") return undefined;
  const command = (input as { command: string }).command.trim().replace(/\s+/g, " ");
  const sensitive = SENSITIVE_COMMAND_RULES.find((rule) => rule.pattern.test(command));
  return sensitive && { rule: sensitive.rule, reason: sensitive.reason, risk: sensitive.risk, category: sensitive.category };
}

/** 等待服务端 bridge 的决定；Abort 与兜底超时一律按拒绝处理。 */
export function createApprovalExtension(fallbackTimeoutMs = 120_000): ExtensionFactory {
  return (pi) => {
    const waiting = new Set<string>();
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash" || ctx.hasUI) return undefined;
      const approval = classifyBashCommand(event.input);
      if (!approval) return undefined;
      const pending: PendingToolApproval = { sessionId: ctx.sessionManager.getSessionId(), toolCallId: event.toolCallId, toolName: event.toolName, args: event.input as Record<string, unknown>, ...approval };
      const key = `${pending.sessionId}:${pending.toolCallId}`;
      if (waiting.has(key)) return { block: true, reason: "Duplicate tool approval request" };
      waiting.add(key);
      const approved = await new Promise<boolean>((resolve) => {
        let off = () => undefined;
        let timer: NodeJS.Timeout | undefined;
        const cleanup = () => { off(); ctx.signal?.removeEventListener("abort", abort); if (timer) clearTimeout(timer); waiting.delete(key); };
        const settle = (value: boolean) => { cleanup(); resolve(value); };
        const abort = () => { pi.events.emit(CHANNEL_ABORTED, { sessionId: pending.sessionId, toolCallId: pending.toolCallId }); settle(false); };
        off = pi.events.on(CHANNEL_DECIDE, (value) => {
          const decision = value as { sessionId?: string; toolCallId?: string; approved?: boolean };
          if (decision.sessionId === pending.sessionId && decision.toolCallId === pending.toolCallId) settle(decision.approved === true);
        });
        ctx.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => settle(false), fallbackTimeoutMs);
        pi.events.emit(CHANNEL_PENDING, pending);
      });
      return approved ? undefined : { block: true, reason: "Tool execution was not approved" };
    });
  };
}
export default createApprovalExtension();

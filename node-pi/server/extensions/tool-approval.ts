/**
 * 工具调用审批扩展：危险命令识别 + 等待服务端审批（Node 版）。
 *
 * 中文说明：Pi 的 bash 工具可以执行任意命令，而 Web 前端没有 Pi 终端的确认 UI，
 * 所以本扩展把"命中危险规则 → 挂起等待审批 → 放行/拦截"拆成两步配合：
 * 1. 命中 DANGEROUS_COMMAND_RULES 里的规则时，通过事件总线（pi.events）把待审批项
 *    发布给 Node 后端（pi:tool_approval:pending），后端推 SSE、前端弹审批框；
 * 2. 本扩展在事件总线上等待后端的决定（pi:tool_approval:decide）——
 *    批准 → 放行；拒绝/超时/中止 → 拦截。
 *
 * 本扩展是"无状态桥"：挂起队列、决策超时都由服务端 ToolApprovalBroker 维护
 * （服务端是唯一真相源，会话销毁时能立即拒绝挂起项）。扩展只做四件事：
 * - 规则匹配（findDangerousBashRule）；
 * - 宿主守卫（ctx.hasUI：TUI/RPC 有自己的确认 UI，直接放行）；
 * - 总线请求/响应桥（发布 pending，等待 decide）；
 * - 中止处理（ctx.signal 只有扩展能拿到：触发时发布 pi:tool_approval:aborted
 *   让服务端清理，并按拒绝结算）。
 *
 * 唯一的本地定时器是"兜底保护"（默认 120 秒）：正常路径下服务端的决策超时
 * （默认 30 秒）远早于它触发；它只防止"宿主激活了本扩展但服务端 broker 缺失"
 * 这类配置错误导致工具调用永久挂起。
 *
 * 事件通道名是扩展与后端之间的契约，两端必须保持一致（见
 * node-pi/server/src/services/tool-approval.ts 里的同名常量）。
 *
 * 规则与 Python 学习后端（pi-python/server/services/tool_approval.py）保持一致，
 * 保证两个后端的审批策略相同。
 *
 * 宿主守卫：本扩展会被任何宿主（TUI / RPC / Web 后端）从任意目录加载，但只应在
 * Web 后端生效。区分依据是 tool_call 处理器的 ctx.hasUI——TUI 与 RPC 有交互式
 * 确认 UI（hasUI === true），直接放行；Web 后端用 createAgentSession 编程式创建，
 * 没有绑定 UI 上下文（hasUI === false），才走事件总线审批。
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** 一条待审批的工具调用（通过事件总线推给后端，再由后端转发 SSE 给前端）。 */
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

/** 事件通道名契约：与 node-pi/server/src/services/tool-approval.ts 保持一致。 */
export const CHANNEL_PENDING = "pi:tool_approval:pending";
export const CHANNEL_DECIDE = "pi:tool_approval:decide";
export const CHANNEL_ABORTED = "pi:tool_approval:aborted";

/**
 * 把审批桥接进 Pi SDK 的扩展系统。
 *
 * 中文说明：Pi 每次调用 bash 工具前会触发 "tool_call" 钩子；命中危险规则时：
 * - 先向事件总线发布 pi:tool_approval:pending（服务端推 SSE，前端弹审批框）；
 * - 再等待服务端发来的 pi:tool_approval:decide 事件；
 * - 批准 → 返回 undefined（放行，工具正常执行）；
 * - 拒绝/超时/中止 → 返回 { block: true, reason }（拦截执行）。
 *
 * 挂起状态与决策超时由服务端 ToolApprovalBroker 维护；这里只用 awaiting 集合
 * 做防重入（同一 toolCall 不会重复发布），并保留一个远超服务端决策超时的兜底
 * 定时器，避免 broker 缺失时工具调用永久挂起。
 *
 * @param fallbackTimeoutMs 兜底等待时长（毫秒），默认 120_000。正常路径由
 *  服务端决策超时（默认 30 秒）控制，该值只在 broker 缺席时生效。
 */
export function createApprovalExtension(fallbackTimeoutMs = 120_000): ExtensionFactory {
  return (pi) => {
    const events = pi.events;
    const awaiting = new Set<string>();
    const key = (sessionId: string, toolCallId: string) => `${sessionId}:${toolCallId}`;

    // 挂起等待审批结果。
    // @returns Promise<boolean>：true = 放行，false = 拒绝。
    // 同一 (session, toolCall) 重复调用会直接返回 false（防重入）。
    const wait = (pending: PendingToolApproval, signal: AbortSignal | undefined): Promise<boolean> => {
      const k = key(pending.sessionId, pending.toolCallId);
      if (awaiting.has(k)) return Promise.resolve(false);
      awaiting.add(k);
      return new Promise((resolve) => {
        let offDecide: () => void = () => undefined;
        let fallback: NodeJS.Timeout | undefined;
        const cleanup = () => {
          offDecide();
          signal?.removeEventListener("abort", onAbort);
          if (fallback) clearTimeout(fallback);
          awaiting.delete(k);
        };
        // settle：无论批准/拒绝/兜底/中止都走这里，负责清理与解析。
        const settle = (approved: boolean) => {
          cleanup();
          resolve(approved);
        };
        const onAbort = () => {
          // 中止只有扩展能感知：通知服务端清理挂起项，并按拒绝结算。
          events.emit(CHANNEL_ABORTED, { sessionId: pending.sessionId, toolCallId: pending.toolCallId });
          settle(false);
        };
        const onDecide = (data: unknown) => {
          const decision = data as { sessionId: string; toolCallId: string; approved: boolean };
          if (decision.sessionId === pending.sessionId && decision.toolCallId === pending.toolCallId) {
            settle(decision.approved);
          }
        };
        offDecide = events.on(CHANNEL_DECIDE, onDecide);
        signal?.addEventListener("abort", onAbort, { once: true });
        fallback = setTimeout(() => settle(false), fallbackTimeoutMs); // 兜底：broker 缺失时避免挂死
        events.emit(CHANNEL_PENDING, pending); // 通知后端（SSE 发布 tool_call_pending）
      });
    };

    pi.on("tool_call", async (event, ctx) => {
      // 只拦截 bash 工具；其他工具（读文件等）直接放行。
      if (event.toolName !== "bash") return undefined;
      // TUI/RPC 有自己的确认 UI：审批只对 Web 后端（无 UI 上下文）生效。
      if (ctx.hasUI) return undefined;
      const rule = findDangerousBashRule(event.input);
      if (!rule) return undefined;
      const pending: PendingToolApproval = {
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.input as Record<string, unknown>,
        reason: rule.reason,
        rule: rule.name,
      };
      const approved = await wait(pending, ctx.signal);
      return approved ? undefined : { block: true, reason: "Tool execution was not approved" };
    });
  };
}

export default createApprovalExtension();

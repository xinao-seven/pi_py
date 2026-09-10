/**
 * 工具调用审批中枢 + 内联扩展。
 *
 * 中文说明：审批的"拦截点"与"有状态的一半"合并到同一个模块（内联扩展，不走 jiti），
 * 因此扩展闭包可直接调用 broker 的方法，不再需要事件总线通道桥。
 * - buildExtension()：注册 tool_call 钩子，命中危险命令规则时调用 requestApproval()
 *   挂起等待决定；决定（前端 approve_tool）、超时、AbortSignal 中止、会话关闭都会结算。
 * - requestApproval()：登记挂起项（防重入 + 决策超时）、触发 onPending 监听
 *   （注册表把它转成 SSE 事件推给前端），返回 Promise<boolean> 表示放行/拦截。
 * - 挂起队列、决策超时与快照都由本类维护，是唯一真相源。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import { ApiError } from '../errors.js';

export type ApprovalRisk = 'medium' | 'high' | 'critical';
export type ApprovalCategory =
  'workspace_write' | 'dependency_change' | 'network' | 'git_remote' | 'destructive' | 'system';

/** 一条待审批的工具调用。 */
export interface PendingToolApproval {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string; // 人类可读的危险原因
  rule: string; // 命中的规则名
  risk: ApprovalRisk;
  category: ApprovalCategory;
  /**
   * M5：当这条待审批来自**子会话**时，它的父会话 id。
   * 中文说明：弹窗会出现在父会话的界面上（子会话没有自己的 UI），
   * 用户点「拒绝」时前端只有父会话 id 可用，所以这里必须记下来。
   */
  parentSessionId?: string;
  /** 子会话的预设名（弹窗上写「子任务 scout 请求执行 …」）。 */
  agent?: string;
}

export interface CommandApproval {
  rule: string;
  reason: string;
  risk: ApprovalRisk;
  category: ApprovalCategory;
}

interface DangerousCommandRule {
  name: string;
  pattern: RegExp;
  reason: string;
}
interface SensitiveCommandRule extends CommandApproval {
  pattern: RegExp;
}

/** 高危规则优先，避免强制推送等操作被普通 Git 规则降级。 */
export const DANGEROUS_COMMAND_RULES: readonly DangerousCommandRule[] = [
  {
    name: 'privileged-delete',
    pattern: /sudo\s+.*\b(rm|del|remove-item)\b/i,
    reason: '使用提权执行删除命令，影响范围可能超出当前工作区',
  },
  {
    name: 'recursive-delete',
    pattern:
      /(^|\b)(rm|rmdir|rd|del|remove-item)(\s|\/).*(-rf|-fr|--recursive|-recurse|\/s)(\s|$)/i,
    reason: '递归或强制删除文件/目录，可能造成不可恢复的数据丢失',
  },
  {
    name: 'file-delete',
    pattern: /(^|[;|&]\s*|\b(?:sudo|command|xargs)\s+)(rm|rmdir|rd|del|remove-item)(\s|$)/i,
    reason: '删除文件或目录会改变工作区内容，需要人工确认',
  },
  {
    name: 'force-delete',
    pattern: /(^|\b)remove-item(\s|\/).*(-force|\/f)(\s|$)/i,
    reason: '强制删除文件或目录，可能造成不可恢复的数据丢失',
  },
  {
    name: 'disk-format',
    pattern: /(^|\b)(format|format-volume|mkfs|mkfs\.[a-z0-9]+|fdisk|diskpart)([.\s]|$)/i,
    reason: '磁盘格式化或分区操作会销毁磁盘数据',
  },
  {
    name: 'raw-disk-write',
    pattern: /(^|\b)dd(\s+.*)?\s+of=\/(dev\/(sd|hd)|dev)\b|>\s*\/dev\/(sd|hd)/i,
    reason: '直接写入磁盘设备会覆盖磁盘内容',
  },
  {
    name: 'shutdown',
    pattern: /(^|\b)(shutdown|restart-computer|stop-computer|reboot|poweroff)(\s|$)/i,
    reason: '关机、重启或断电会中断当前机器',
  },
  {
    name: 'force-push',
    pattern: /git\s+(push|fetch)\s+.*(-f|--force)\b/i,
    reason: '强制推送或拉取 Git 历史，可能覆盖远端提交',
  },
  {
    name: 'bulk-uninstall',
    pattern:
      /(^|\b)(pip|npm|conda|apt|apt-get|dnf|yum)\s+(uninstall|remove|purge)(\s|$).*(-y\b|--yes\b|-y$)/i,
    reason: '批量卸载软件包，可能破坏开发环境',
  },
  {
    name: 'pipe-remote-script',
    pattern:
      /(curl|wget|iwr|invoke-webrequest|invoke-restmethod)[^\n|]*\s*\|\s*(sh|bash|zsh|iex|powershell)/i,
    reason: '将远程脚本直接管道执行，可能运行未知代码',
  },
  {
    name: 'recursive-chmod',
    pattern: /chmod\s+(-r\s+)?777\s+\/\s*$|chown\s+(-r\s+)?[^\s]+\s+\//i,
    reason: '递归修改根目录权限或属主，可能使系统不可用',
  },
  {
    name: 'registry-delete',
    pattern: /(^|\b)reg\s+delete\b/i,
    reason: '删除 Windows 注册表项，可能损坏系统配置',
  },
  {
    name: 'fork-bomb',
    pattern: /:\(\)\s*\{.*\|.*&.*\}/,
    reason: 'fork 炸弹会使系统资源耗尽',
  },
];
export const SENSITIVE_COMMAND_RULES: readonly SensitiveCommandRule[] = [
  {
    rule: 'git-remote-write',
    pattern: /\bgit\s+(push|fetch)\b/i,
    reason: 'Git 远端操作可能写入远端分支或改变本地远端跟踪状态',
    risk: 'high',
    category: 'git_remote',
  },
  {
    rule: 'dependency-change',
    pattern:
      /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv)\s+(?:install|add|update|upgrade|remove|uninstall|publish)\b/i,
    reason: '安装、更新、卸载或发布依赖会改变项目环境或向外部发布内容',
    risk: 'high',
    category: 'dependency_change',
  },
  {
    rule: 'network-request',
    pattern: /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b/i,
    reason: '命令将访问网络；请确认目标和传输的数据符合预期',
    risk: 'medium',
    category: 'network',
  },
  {
    rule: 'shell-redirection-write',
    pattern: /(?:^|\s)(?:>|>>)|\b(?:tee|out-file|set-content|add-content)\b/i,
    reason: 'Shell 重定向会直接写入文件，可能覆盖或追加工作区内容',
    risk: 'medium',
    category: 'workspace_write',
  },
];

export function findDangerousBashRule(input: unknown): DangerousCommandRule | undefined {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof (input as { command?: unknown }).command !== 'string'
  )
    return undefined;
  const command = (input as { command: string }).command.trim().replace(/\s+/g, ' ');
  return DANGEROUS_COMMAND_RULES.find((rule) => rule.pattern.test(command));
}
function dangerousCategory(name: string): ApprovalCategory {
  if (name === 'force-push') return 'git_remote';
  if (name === 'pipe-remote-script') return 'network';
  return [
    'shutdown',
    'disk-format',
    'raw-disk-write',
    'registry-delete',
    'recursive-chmod',
    'fork-bomb',
  ].includes(name)
    ? 'system'
    : 'destructive';
}
/** 判断一条 bash 命令是否需要人工审批：危险规则 → critical；敏感规则 → medium/high。 */
export function classifyBashCommand(input: unknown): CommandApproval | undefined {
  const dangerous = findDangerousBashRule(input);
  if (dangerous)
    return {
      rule: dangerous.name,
      reason: dangerous.reason,
      risk: 'critical',
      category: dangerousCategory(dangerous.name),
    };
  if (
    !input ||
    typeof input !== 'object' ||
    typeof (input as { command?: unknown }).command !== 'string'
  )
    return undefined;
  const command = (input as { command: string }).command.trim().replace(/\s+/g, ' ');
  const sensitive = SENSITIVE_COMMAND_RULES.find((rule) => rule.pattern.test(command));
  return (
    sensitive && {
      rule: sensitive.rule,
      reason: sensitive.reason,
      risk: sensitive.risk,
      category: sensitive.category,
    }
  );
}

/** ToolApprovalBroker 构造选项。 */
export interface ToolApprovalOptions {
  /** 前端未审批时的自动拒绝等待时长（毫秒），默认 30_000。 */
  timeoutMs?: number;
}

/**
 * 审批生命周期的观测钩子（可选）。
 *
 * 中文说明：只声明可观测性需要知道的两件事——挂起与结算。用结构化接口（而不是直接
 * 依赖 SessionLedger）是为了让审批中枢保持独立，同时避免两个模块互相 import。
 * 实现方**必须自行吞掉异常**，审批流程不得因观测失败而改变结果。
 */
export interface ApprovalTraceSink {
  noteApprovalStart(pending: PendingToolApproval): void;
  noteApprovalDecision(input: {
    sessionId: string;
    toolCallId: string;
    decision: 'approved' | 'denied' | 'timed_out';
    decidedBy: string;
  }): void;
}

/** 结算原因：区分人工决定、超时、中止与会话清理。 */
type SettlementSource = 'user' | 'timeout' | 'abort' | 'session' | 'disposed';

/** 一个正在等待审批的挂起项（内部用）。 */
interface Waiter {
  pending: PendingToolApproval;
  timer: NodeJS.Timeout;
  settle(decision: 'approved' | 'denied' | 'timed_out', decidedBy: SettlementSource): void;
  abort: () => void;
}

/**
 * 服务端审批中枢：维护挂起队列 + 决策超时，并以内联扩展注册 bash 拦截。
 * 中文说明：不依赖 Fastify/SSE/事件总线，便于单元测试；buildExtension() 生成的扩展
 * 闭包直接引用本实例，requestApproval() 的 Promise 在决定/超时/中止/取消时结算。
 */
export class ToolApprovalBroker {
  private readonly waiting = new Map<string, Waiter>();
  private onPending: ((pending: PendingToolApproval) => void) | undefined;
  private trace: ApprovalTraceSink | undefined;
  /** 子会话 → 父会话（M5）。由注册表注入：审批中枢不该自己知道会话树。 */
  private parentResolver:
    ((sessionId: string) => { parentSessionId: string; agent?: string } | undefined) | undefined;

  constructor(private readonly options: ToolApprovalOptions = {}) {}

  /**
   * 生成"bash 危险命令审批"内联扩展：命中规则时挂起等待，未命中或 TUI/RPC 宿主直接放行。
   * 中文说明：host 守卫保留 ctx.hasUI——即使将来该扩展被共享到 TUI/RPC 宿主加载，
   * 也不会绕过其自身的确认 UI。
   */
  buildExtension(): InlineExtension {
    return (pi: ExtensionAPI) => {
      pi.on('tool_call', async (event, ctx) => {
        if (event.toolName !== 'bash' || ctx.hasUI) return undefined;
        const approval = classifyBashCommand(event.input);
        if (!approval) return undefined;
        const sessionId = ctx.sessionManager.getSessionId();
        // 子会话的审批要带上父会话（弹窗出现在父会话界面，见 announceApproval）。
        const lineage = this.parentResolver?.(sessionId);
        const pending: PendingToolApproval = {
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.input as Record<string, unknown>,
          ...approval,
          ...(lineage === undefined
            ? {}
            : {
                parentSessionId: lineage.parentSessionId,
                ...(lineage.agent === undefined ? {} : { agent: lineage.agent }),
              }),
        };
        const approved = await this.requestApproval(pending, ctx.signal);
        return approved ? undefined : { block: true, reason: 'Tool execution was not approved' };
      });
    };
  }

  /**
   * 登记一个待审批项并等待决定：防重入 + 决策超时 + AbortSignal 中止感知。
   * 返回 true 放行、false 拦截；重复登记同一调用直接返回 false。
   * timeoutMs 可覆盖构造时的默认值（MCP 审批需要更长的等待窗口）。
   */
  requestApproval(
    pending: PendingToolApproval,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<boolean> {
    const key = this.key(pending.sessionId, pending.toolCallId);
    if (this.waiting.has(key)) return Promise.resolve(false); // 同一调用不会重复挂起
    return new Promise((resolve) => {
      let settled = false;
      // settle：无论批准/拒绝/超时/中止都走这里，负责清定时器、清快照、resolve。
      const settle = (
        decision: 'approved' | 'denied' | 'timed_out',
        decidedBy: SettlementSource,
      ): void => {
        if (settled) return;
        settled = true;
        const waiter = this.waiting.get(key);
        if (!waiter) return; // 已结算过（幂等）
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', abort);
        this.waiting.delete(key);
        this.notify(() =>
          this.trace?.noteApprovalDecision({
            sessionId: pending.sessionId,
            toolCallId: pending.toolCallId,
            decision,
            decidedBy,
          }),
        );
        resolve(decision === 'approved');
      };
      const abort = (): void => settle('denied', 'abort');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => settle('timed_out', 'timeout'),
        timeoutMs ?? this.options.timeoutMs ?? 30_000,
      );
      this.waiting.set(key, { pending, timer, settle, abort });
      this.onPending?.(pending);
      this.notify(() => this.trace?.noteApprovalStart(pending));
    });
  }

  /** 注册“有新待审批项”的监听器（注册表用它发 SSE 事件）。 */
  setPendingListener(listener: (pending: PendingToolApproval) => void): void {
    this.onPending = listener;
  }

  /** 注册可观测性钩子（账本用它记审批命中率与等待时长）。 */
  setTraceSink(sink: ApprovalTraceSink): void {
    this.trace = sink;
  }

  /** 注册「子会话 → 父会话」解析器（M5）：注册表注入，审批中枢不依赖会话树。 */
  setParentResolver(
    resolver: (sessionId: string) => { parentSessionId: string; agent?: string } | undefined,
  ): void {
    this.parentResolver = resolver;
  }

  /**
   * 前端给出审批结论（approve_tool 命令的底层实现）：结算挂起项。
   *
   * 中文说明：传入的 `sessionId` 可能是**父会话**（子会话的弹窗显示在父会话界面上），
   * 因此先按 `sessionId:toolCallId` 精确查，再按「这条挂起项属于该父会话」回退查。
   */
  decide(sessionId: string, toolCallId: string, approved: boolean): void {
    const waiter =
      this.waiting.get(this.key(sessionId, toolCallId)) ??
      this.findChildWaiter(sessionId, toolCallId);
    if (!waiter)
      throw new ApiError(404, 'approval_not_found', 'Tool approval is no longer pending');
    waiter.settle(approved ? 'approved' : 'denied', 'user');
  }

  /**
   * 会话关闭/删除时，把该会话所有挂起项按“拒绝”结算。
   * 中文说明：父会话关闭时，它名下子会话的挂起项同样要结算，否则子会话的
   * tool_call 会一直等到超时（父会话已经不在了，用户不可能再点）。
   */
  cancelSession(sessionId: string): void {
    for (const [key, waiter] of [...this.waiting]) {
      if (key.startsWith(`${sessionId}:`) || waiter.pending.parentSessionId === sessionId)
        waiter.settle('denied', 'session');
    }
  }

  /** 按「该挂起项属于这个父会话」找（子会话审批被父会话结算时的回退路径）。 */
  private findChildWaiter(parentSessionId: string, toolCallId: string): Waiter | undefined {
    for (const waiter of this.waiting.values()) {
      if (waiter.pending.toolCallId !== toolCallId) continue;
      if (waiter.pending.parentSessionId === parentSessionId) return waiter;
    }
    return undefined;
  }

  /** 查询某会话当前是否有待审批项（供状态快照展示 pendingToolCall）。 */
  pendingForSession(sessionId: string): PendingToolApproval | undefined {
    for (const [key, waiter] of this.waiting) {
      if (key.startsWith(`${sessionId}:`)) return waiter.pending;
    }
    return undefined;
  }

  /** 把仍挂起的审批按“拒绝”结算（服务关闭时调用）。 */
  dispose(): void {
    for (const [, waiter] of [...this.waiting]) waiter.settle('denied', 'disposed');
  }

  /** 待审批项的唯一键：sessionId:toolCallId。 */
  private key(sessionId: string, toolCallId: string): string {
    return `${sessionId}:${toolCallId}`;
  }

  /** 观测钩子调用点：观测失败绝不能影响审批结果。 */
  private notify(action: () => void): void {
    try {
      action();
    } catch {
      // 可观测性是增量能力，静默降级。
    }
  }
}

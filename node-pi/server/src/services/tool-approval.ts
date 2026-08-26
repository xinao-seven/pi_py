/**
 * 工具调用审批的 Web 桥接层（事件总线版）。
 *
 * 中文说明：审批逻辑的拦截点仍在扩展（node-pi/server/extensions/tool-approval.ts，
 * 通过 tool_call 钩子），本模块是"有状态"的那一半——挂起队列、决策超时、
 * 快照都由这里维护，是唯一真相源：
 * - 订阅 pi:tool_approval:pending：扩展命中危险规则时发布，本类创建挂起项
 *   （带决策超时，默认 30 秒）、触发 onPending 监听（注册表把它转成 SSE 事件推给前端）；
 * - decide()：前端审批后结算挂起项，并发布 pi:tool_approval:decide 让扩展放行/拦截；
 * - 订阅 pi:tool_approval:aborted：扩展感知到工具调用被中止（AbortSignal）时发布，
 *   本类按"拒绝"结算；
 * - cancelSession()：会话关闭/删除时把该会话所有挂起项按"拒绝"结算；
 * - 结算（settle）时会自动清理快照，state() 不会返回过期的 pendingToolCall。
 *
 * 事件通道名是两端之间的契约，必须与扩展里的同名常量保持一致。
 * 扩展与服务器不共享模块实例（jiti 隔离），所以所有通信都走事件总线。
 */

import type { EventBus } from '@earendil-works/pi-coding-agent';

import { ApiError } from '../errors.js';

/** 一条待审批的工具调用（与扩展约定的数据结构，两端必须一致）。 */
export interface PendingToolApproval {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string; // 人类可读的危险原因
  rule: string; // 命中的规则名
  risk: 'medium' | 'high' | 'critical';
  category:
    'workspace_write' | 'dependency_change' | 'network' | 'git_remote' | 'destructive' | 'system';
}

/** 事件通道名契约：与 node-pi/server/extensions/tool-approval.ts 保持一致。 */
export const CHANNEL_PENDING = 'pi:tool_approval:pending';
export const CHANNEL_DECIDE = 'pi:tool_approval:decide';
export const CHANNEL_ABORTED = 'pi:tool_approval:aborted';

/** ToolApprovalBroker 构造选项。 */
export interface ToolApprovalOptions {
  /** 前端未审批时的自动拒绝等待时长（毫秒），默认 30_000。 */
  timeoutMs?: number;
}

/** 一个正在等待审批的挂起项（内部用）。 */
interface Waiter {
  pending: PendingToolApproval;
  timer: NodeJS.Timeout;
  settle: (approved: boolean) => void;
}

/**
 * 服务端审批中枢：维护挂起队列 + 决策超时 + 通过事件总线向扩展收发结论。
 * 中文说明：不依赖 Fastify/SSE，便于单元测试；事件总线由 app.ts 创建并注入，
 * 同一个实例同时传给 AgentRegistry（订阅）与 OriginalPiSessionFactory（给 loader，
 * 最终成为扩展的 pi.events）。
 */
export class ToolApprovalBroker {
  private readonly waiting = new Map<string, Waiter>();
  private onPending: ((pending: PendingToolApproval) => void) | undefined;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly events: EventBus,
    private readonly options: ToolApprovalOptions = {},
  ) {
    // 扩展命中危险规则后发布待审批项：创建带决策超时的挂起项，并通知监听器（注册表发 SSE）。
    this.offs.push(
      events.on(CHANNEL_PENDING, (data) => {
        const pending = data as PendingToolApproval;
        this.addPending(pending);
      }),
    );
    // 扩展感知工具调用被中止（AbortSignal）：按"拒绝"结算并清空快照。
    this.offs.push(
      events.on(CHANNEL_ABORTED, (data) => {
        const aborted = data as { sessionId: string; toolCallId: string };
        const waiter = this.waiting.get(this.key(aborted.sessionId, aborted.toolCallId));
        if (waiter) waiter.settle(false);
      }),
    );
  }

  /** 登记一个待审批项：防重入 + 启动决策超时。 */
  private addPending(pending: PendingToolApproval): void {
    const key = this.key(pending.sessionId, pending.toolCallId);
    if (this.waiting.has(key)) return; // 同一调用不会重复挂起
    // settle：无论批准/拒绝/超时都走这里，负责清定时器、清快照，并通知扩展。
    const settle = (approved: boolean): void => {
      const waiter = this.waiting.get(key);
      if (!waiter) return; // 已结算过（幂等）
      clearTimeout(waiter.timer);
      this.waiting.delete(key);
      this.events.emit(CHANNEL_DECIDE, {
        sessionId: pending.sessionId,
        toolCallId: pending.toolCallId,
        approved,
      });
    };
    const timer = setTimeout(() => settle(false), this.options.timeoutMs ?? 30_000);
    this.waiting.set(key, { pending, timer, settle });
    this.onPending?.(pending);
  }

  /** 注册"有新待审批项"的监听器（注册表用它发 SSE 事件）。 */
  setPendingListener(listener: (pending: PendingToolApproval) => void): void {
    this.onPending = listener;
  }

  /** 前端给出审批结论（approve_tool 命令的底层实现）：结算挂起项并把决定发给扩展。 */
  decide(sessionId: string, toolCallId: string, approved: boolean): void {
    const waiter = this.waiting.get(this.key(sessionId, toolCallId));
    if (!waiter)
      throw new ApiError(404, 'approval_not_found', 'Tool approval is no longer pending');
    waiter.settle(approved);
  }

  /** 会话关闭/删除时，把该会话所有挂起项按"拒绝"结算。 */
  cancelSession(sessionId: string): void {
    for (const [key, waiter] of [...this.waiting]) {
      if (key.startsWith(`${sessionId}:`)) waiter.settle(false);
    }
  }

  /** 查询某会话当前是否有待审批项（供状态快照展示 pendingToolCall）。 */
  pendingForSession(sessionId: string): PendingToolApproval | undefined {
    for (const [key, waiter] of this.waiting) {
      if (key.startsWith(`${sessionId}:`)) return waiter.pending;
    }
    return undefined;
  }

  /** 释放对事件总线的订阅，并把仍挂起的审批按"拒绝"结算（服务关闭时调用）。 */
  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const [, waiter] of [...this.waiting]) waiter.settle(false);
  }

  /** 待审批项的唯一键：sessionId:toolCallId。 */
  private key(sessionId: string, toolCallId: string): string {
    return `${sessionId}:${toolCallId}`;
  }
}

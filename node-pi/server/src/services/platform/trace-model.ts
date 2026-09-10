/**
 * 可观测数据的领域模型（runs / steps）与跨后端共享的纯函数。
 *
 * 中文说明：SQLite 与内存两个存储实现共享本文件的类型与纯函数，让「会话事件 → 行」
 * 的语义只有一处定义。最重要的是 `blockedBy` 与「真实错误」的判定：SDK 对策略拦截
 * （审批拒绝、规划期只读）与工具真实失败都只发 `tool_execution_end(isError=true)`，
 * 若不区分，`byTool.errorRate` 从第一天就是错的（见 docs/node-platform-m0-spike.md）。
 */

/** run 的状态机：running 是唯一非终态。 */
export type RunStatus = 'running' | 'completed' | 'aborted' | 'error';

/** 步骤类型（与规划文档 §4.1.1 的 kind 取值一致）。 */
export type StepKind =
  'llm_call' | 'tool_call' | 'approval' | 'compaction' | 'branch_summary' | 'memory_write';

/** 策略阻断来源：非空表示该 tool_call 是被拦下的，不是执行失败。 */
export type BlockedBy = 'approval' | 'plan_mode' | 'policy';

/** 一次 agent run（一次 prompt 触发的完整循环，含多轮 turn）。 */
export interface RunRow {
  id: string;
  sessionId: string;
  parentRunId?: string; // M5 subagent 用；M1 建表即预留，避免再迁移
  taskId?: string; // M2 任务领域用
  cwd: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  ttftMs?: number;
  durationMs?: number;
  stopReason?: string;
  errorType?: string;
  errorMessage?: string;
  meta?: Record<string, unknown>;
}

/** run 结束时的增量补丁（与 RunRow 的累计字段同名，便于直接合并）。 */
export type RunFinish = Pick<
  RunRow,
  | 'endedAt'
  | 'status'
  | 'turns'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
  | 'ttftMs'
  | 'durationMs'
  | 'stopReason'
  | 'errorType'
  | 'errorMessage'
  | 'meta'
>;

/** 一个步骤（模型调用 / 工具调用 / 审批 / 压缩）。 */
export interface StepRow {
  runId: string;
  sessionId: string;
  turnIndex: number;
  kind: StepKind;
  toolName?: string;
  toolCallId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /** SDK 原始值：策略拦截时也是 true，统计口径请用 isRealError()。 */
  isError: boolean;
  /** 非空＝被策略拦截（审批拒绝/超时、规划期只读等）。 */
  blockedBy?: BlockedBy;
  errorType?: string;
  errorMessage?: string;
  argsDigest?: string;
  argsBytes?: number;
  resultDigest?: string;
  resultBytes?: number;
  approvalRule?: string;
  approvalRisk?: string;
  approvalDecision?: 'approved' | 'denied' | 'timed_out';
  approvalWaitMs?: number;
  decidedBy?: string;
  meta?: Record<string, unknown>;
}

/**
 * 时间窗口 + 工作区过滤条件（Dashboard 查询用）。
 *
 * 中文说明：计数/成本/token 这类聚合的时间分辨率为**天 + cwd**（预聚合表），
 * 只有分位数样本按精确窗口从明细表取最近 N 条；未结算（running）的 run 不计入聚合。
 */
export interface TraceQuery {
  from?: number; // 毫秒时间戳（含）
  to?: number; // 毫秒时间戳（不含）
  cwd?: string;
  /** 分位数样本上限：p50/p95 基于范围内最近 N 条样本，默认 2000。 */
  sampleLimit?: number;
}

/** run 列表的键集分页条件（游标＝startedAt:runId）。 */
export interface RunQuery extends TraceQuery {
  sessionId?: string;
  taskId?: string;
  limit: number;
  cursor?: string;
}

/** 被策略拦下的 tool_call 不算工具失败（M0 修正 ④）。 */
export function isRealError(step: Pick<StepRow, 'isError' | 'blockedBy'>): boolean {
  return step.isError && step.blockedBy === undefined;
}

/** 按 UTC 日期分桶（预聚合表的 key）。 */
export function dayOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** 分页游标编解码：`${startedAt}:${runId}`（runId 不含冒号）。 */
export function encodeCursor(run: Pick<RunRow, 'startedAt' | 'id'>): string {
  return `${run.startedAt}:${run.id}`;
}

export function decodeCursor(
  cursor: string | undefined,
): { startedAt: number; id: string } | undefined {
  if (!cursor) return undefined;
  const index = cursor.indexOf(':');
  if (index <= 0) return undefined;
  const startedAt = Number(cursor.slice(0, index));
  const id = cursor.slice(index + 1);
  if (!Number.isFinite(startedAt) || !id) return undefined;
  return { startedAt, id };
}

/**
 * 可观测性的聚合整形层。
 *
 * 中文说明：存储层只返回「原始聚合」（计数、求和、有界样本），本文件负责
 * 分位数计算与 REST 响应整形，是纯函数，便于单测。
 *
 * 分位数口径（性能与诚实度的折中）：
 * - p50/p95 基于**范围内最近 N 条样本**（默认 2000，见 DEFAULT_SAMPLE_LIMIT）；
 *   样本不足 N 时就是精确值，超过则是「最近样本」的近似值。
 * - 为什么不存直方图：等宽直方图需要为每个工具维护几百个桶，误差与行数两头不讨好；
 *   而全表排序正是 M0 实测的 96ms 风险点。有界样本 + 预聚合计数是更好的取舍。
 */

import type {
  ApprovalAggregate,
  DailyAggregate,
  ModelAggregate,
  RunDetail,
  SummaryData,
  ToolAggregate,
  TraceStoreStats,
} from '../platform/trace-repository.js';
import type { RunRow, StepRow } from '../platform/trace-model.js';

/** REST 返回的汇总（字段与规划 §4.1.4 一致）。 */
export interface ObservabilitySummary {
  totals: {
    runs: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    p50DurationMs: number;
    p95DurationMs: number;
    p50TtftMs: number;
    errorRate: number;
  };
  byModel: Array<{
    provider: string | null;
    model: string | null;
    runs: number;
    costUsd: number;
    tokens: number;
    p95DurationMs: number;
  }>;
  byTool: Array<{
    toolName: string;
    calls: number;
    errors: number;
    blocked: number;
    errorRate: number;
    p50DurationMs: number;
    p95DurationMs: number;
  }>;
  byApproval: Array<{
    rule: string;
    risk: string;
    approved: number;
    denied: number;
    timedOut: number;
    p50WaitMs: number;
  }>;
  daily: Array<{
    date: string;
    runs: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  /** 追加字段（非规划契约）：让面板能显示 trace 是否降级/被关闭。 */
  store?: { mode: TraceStoreStats['mode']; degraded: boolean; pending: number; dropped: number };
}

export interface RunPayload {
  id: string;
  sessionId: string;
  parentRunId: string | null;
  taskId: string | null;
  cwd: string;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  startedAt: string;
  endedAt: string | null;
  status: RunRow['status'];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  ttftMs: number | null;
  durationMs: number | null;
  stopReason: string | null;
  errorType: string | null;
  errorMessage: string | null;
  meta: Record<string, unknown> | null;
}

export interface StepPayload {
  kind: StepRow['kind'];
  turnIndex: number;
  toolName: string | null;
  toolCallId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  isError: boolean;
  blockedBy: string | null;
  errorType: string | null;
  errorMessage: string | null;
  argsDigest: string | null;
  argsBytes: number | null;
  resultDigest: string | null;
  resultBytes: number | null;
  approvalRule: string | null;
  approvalRisk: string | null;
  approvalDecision: string | null;
  approvalWaitMs: number | null;
  decidedBy: string | null;
  meta: Record<string, unknown> | null;
}

export interface RunDetailPayload {
  run: RunPayload;
  steps: StepPayload[];
  children: RunPayload[];
}

/**
 * 分位数（nearest-rank）。
 * 中文说明：样本为 0 时返回 0；索引取 ceil(p*n)-1，n=1 时任何 p 都返回该样本。
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rate(part: number, total: number): number {
  return total === 0 ? 0 : round(part / total, 4);
}

/** 原始聚合 → REST 汇总。 */
export function buildSummary(data: SummaryData, store?: TraceStoreStats): ObservabilitySummary {
  const summary: ObservabilitySummary = {
    totals: {
      runs: data.totals.runs,
      turns: data.totals.turns,
      inputTokens: data.totals.inputTokens,
      outputTokens: data.totals.outputTokens,
      cacheReadTokens: data.totals.cacheReadTokens,
      costUsd: round(data.totals.costUsd, 6),
      p50DurationMs: Math.round(percentile(data.totals.durationSamples, 0.5)),
      p95DurationMs: Math.round(percentile(data.totals.durationSamples, 0.95)),
      p50TtftMs: Math.round(percentile(data.totals.ttftSamples, 0.5)),
      errorRate: rate(data.totals.errorRuns, data.totals.runs),
    },
    byModel: data.byModel.map((item: ModelAggregate) => ({
      provider: item.provider ?? null,
      model: item.model ?? null,
      runs: item.runs,
      costUsd: round(item.costUsd, 6),
      tokens: item.tokens,
      p95DurationMs: Math.round(percentile(item.durationSamples, 0.95)),
    })),
    byTool: data.byTool.map((item: ToolAggregate) => ({
      toolName: item.toolName,
      calls: item.calls,
      errors: item.errors,
      blocked: item.blocked,
      errorRate: rate(item.errors, item.calls),
      p50DurationMs: Math.round(percentile(item.durationSamples, 0.5)),
      p95DurationMs: Math.round(percentile(item.durationSamples, 0.95)),
    })),
    byApproval: data.byApproval.map((item: ApprovalAggregate) => ({
      rule: item.rule,
      risk: item.risk,
      approved: item.approved,
      denied: item.denied,
      timedOut: item.timedOut,
      p50WaitMs: Math.round(percentile(item.waitSamples, 0.5)),
    })),
    daily: data.daily.map((item: DailyAggregate) => ({
      date: item.date,
      runs: item.runs,
      costUsd: round(item.costUsd, 6),
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
    })),
  };
  if (store) {
    summary.store = {
      mode: store.mode,
      degraded: store.degraded,
      pending: store.pending,
      dropped: store.dropped,
    };
  }
  return summary;
}

/** 时间戳 → ISO（无值时为 null，前端不必处理 undefined）。 */
function iso(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

export function serializeRun(run: RunRow): RunPayload {
  return {
    id: run.id,
    sessionId: run.sessionId,
    parentRunId: run.parentRunId ?? null,
    taskId: run.taskId ?? null,
    cwd: run.cwd,
    provider: run.provider ?? null,
    model: run.model ?? null,
    thinkingLevel: run.thinkingLevel ?? null,
    startedAt: iso(run.startedAt) ?? '',
    endedAt: iso(run.endedAt),
    status: run.status,
    turns: run.turns,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    costUsd: round(run.costUsd, 6),
    ttftMs: run.ttftMs ?? null,
    durationMs: run.durationMs ?? null,
    stopReason: run.stopReason ?? null,
    errorType: run.errorType ?? null,
    errorMessage: run.errorMessage ?? null,
    meta: run.meta ?? null,
  };
}

export function serializeStep(step: StepRow): StepPayload {
  return {
    kind: step.kind,
    turnIndex: step.turnIndex,
    toolName: step.toolName ?? null,
    toolCallId: step.toolCallId ?? null,
    startedAt: iso(step.startedAt) ?? '',
    endedAt: iso(step.endedAt),
    durationMs: step.durationMs ?? null,
    isError: step.isError,
    blockedBy: step.blockedBy ?? null,
    errorType: step.errorType ?? null,
    errorMessage: step.errorMessage ?? null,
    argsDigest: step.argsDigest ?? null,
    argsBytes: step.argsBytes ?? null,
    resultDigest: step.resultDigest ?? null,
    resultBytes: step.resultBytes ?? null,
    approvalRule: step.approvalRule ?? null,
    approvalRisk: step.approvalRisk ?? null,
    approvalDecision: step.approvalDecision ?? null,
    approvalWaitMs: step.approvalWaitMs ?? null,
    decidedBy: step.decidedBy ?? null,
    meta: step.meta ?? null,
  };
}

/** run 详情：steps 按时间正序（出错的那一步更好定位）。 */
export function serializeRunDetail(detail: RunDetail): RunDetailPayload {
  return {
    run: serializeRun(detail.run),
    steps: detail.steps.map(serializeStep),
    children: detail.children.map(serializeRun),
  };
}

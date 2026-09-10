/**
 * trace 仓库：对外写入 API + 写入队列 + 读接口契约。
 *
 * 中文说明：分层目的是让「阻塞风险」只出现在一个地方。
 * - `TraceStorage`：具体后端（SQLite / 内存），只做同步批量落库与查询；
 * - `QueuedTraceRepository`：把零散的 record 攒成批（250ms 或 200 条），
 *   一次性交给后端在一个事务里写；读之前强制 flush，保证「刚发生的事件」立即可查；
 * - `NullTraceRepository`：trace 关闭时的空实现（关掉配置后行为与今天完全一致）。
 *
 * 降级策略（agent loop 绝不能被 trace 拖死）：
 * - 队列超过 maxPending → 丢最旧的一条并计数（内存有上限，不无限增长）；
 * - 后端 apply 抛错 → 记 warn 并清空本批；连续失败 3 次后进入 degraded 态，
 *   后续写入直接丢弃（只计数），不再反复撞同一个错误；
 * - close() 之后的写入一律丢弃。
 */

import type { ServiceLogger } from '../service-logger.js';
import {
  decodeCursor,
  isRealError,
  type RunQuery,
  type RunRow,
  type RunFinish,
  type StepRow,
  type TraceQuery,
} from './trace-model.js';

/** run 维度的聚合原始数据（分位数由 metrics.ts 计算）。 */
export interface RunTotals {
  runs: number;
  errorRuns: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  durationSamples: number[];
  ttftSamples: number[];
}

export interface ModelAggregate {
  provider?: string;
  model?: string;
  runs: number;
  costUsd: number;
  tokens: number;
  durationSamples: number[];
}

export interface ToolAggregate {
  toolName: string;
  calls: number;
  errors: number;
  blocked: number;
  durationMsSum: number;
  durationSamples: number[];
}

export interface ApprovalAggregate {
  rule: string;
  risk: string;
  approved: number;
  denied: number;
  timedOut: number;
  waitMsSum: number;
  waitSamples: number[];
}

export interface DailyAggregate {
  date: string;
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** 存储层返回的聚合原始数据（尚未算分位数、尚未整形）。 */
export interface SummaryData {
  totals: RunTotals;
  byModel: ModelAggregate[];
  byTool: ToolAggregate[];
  byApproval: ApprovalAggregate[];
  daily: DailyAggregate[];
}

export interface RunListResult {
  runs: RunRow[];
  nextCursor?: string;
}

export interface RunDetail {
  run: RunRow;
  steps: StepRow[];
  children: RunRow[];
}

/** 只读接口：聚合与详情查询（Dashboard / REST 只用它）。 */
export interface TraceReader {
  summary(query: TraceQuery): SummaryData;
  listRuns(query: RunQuery): RunListResult;
  getRun(runId: string): RunDetail | undefined;
  /** 删除 before（毫秒时间戳）之前的明细，返回删除的 run 数；预聚合表保留。 */
  prune(before: number): number;
}

/** 存储后端：在只读接口之上增加「批量应用写入操作」。 */
export interface TraceStorage extends TraceReader {
  /** 同步批量应用（实现方负责包事务）。 */
  apply(ops: readonly TraceOp[]): void;
  close(): void;
}

/** 队列里的写入操作。 */
export type TraceOp =
  | { op: 'run_start'; run: RunRow }
  | { op: 'run_finish'; runId: string; patch: RunFinish }
  | { op: 'step'; step: StepRow };

/** 对外仓库：写入进队列，读前 flush。 */
export interface TraceRepository extends TraceReader {
  startRun(run: RunRow): void;
  finishRun(runId: string, patch: RunFinish): void;
  addStep(step: StepRow): void;
  flush(): void;
  close(): void;
  stats(): TraceStoreStats;
}

export interface TraceStoreStats {
  mode: 'sqlite' | 'memory' | 'off';
  pending: number;
  recorded: number;
  flushed: number;
  dropped: number;
  failedFlushes: number;
  degraded: boolean;
  lastFlushMs: number;
}

/** 队列配置。 */
export interface TraceQueueOptions {
  /** 攒批时间上限（毫秒），默认 250。 */
  flushMs: number;
  /** 攒批条数上限，达到即立刻 flush，默认 200。 */
  batchSize: number;
  /** 队列硬上限，超出丢最旧的一条并计数，默认 5000。 */
  maxPending: number;
  /** 连续失败多少次后进入 degraded 态，默认 3。 */
  maxConsecutiveFailures?: number;
}

export const DEFAULT_TRACE_QUEUE: TraceQueueOptions = {
  flushMs: 250,
  batchSize: 200,
  maxPending: 5000,
  maxConsecutiveFailures: 3,
};

/**
 * 写入队列 + 只读委派。
 * 中文说明：写入路径完全不 await、不抛错（调用方是 agent loop 的事件回调）；
 * 读路径先 flush 再查，保证读到的数据包含此前所有已 record 的内容。
 */
export class QueuedTraceRepository implements TraceRepository {
  private readonly pending: TraceOp[] = [];
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private degraded = false;
  private consecutiveFailures = 0;
  private recorded = 0;
  private flushed = 0;
  private dropped = 0;
  private failedFlushes = 0;
  private lastFlushMs = 0;
  private readonly mode: 'sqlite' | 'memory';

  constructor(
    private readonly storage: TraceStorage,
    mode: 'sqlite' | 'memory',
    private readonly options: TraceQueueOptions = DEFAULT_TRACE_QUEUE,
    private readonly logger?: ServiceLogger,
  ) {
    this.mode = mode;
    this.timer = setInterval(() => this.flush(), this.options.flushMs);
    // 定时器不应该阻止进程退出（测试里尤其重要）。
    this.timer.unref?.();
  }

  startRun(run: RunRow): void {
    this.enqueue({ op: 'run_start', run });
  }

  finishRun(runId: string, patch: RunFinish): void {
    this.enqueue({ op: 'run_finish', runId, patch });
  }

  addStep(step: StepRow): void {
    this.enqueue({ op: 'step', step });
  }

  /** 把队列里的操作一次性交给后端；任何异常都在这里被吸收。 */
  flush(): void {
    if (this.closed || this.pending.length === 0) return;
    const ops = this.pending.splice(0, this.pending.length);
    const startedAt = performance.now();
    try {
      this.storage.apply(ops);
      this.flushed += ops.length;
      this.consecutiveFailures = 0;
      this.lastFlushMs = performance.now() - startedAt;
    } catch (error) {
      this.failedFlushes += 1;
      this.consecutiveFailures += 1;
      this.logger?.warn(
        { ops: ops.length, error: error instanceof Error ? error.message : String(error) },
        'trace flush failed; batch dropped',
      );
      if (this.consecutiveFailures >= (this.options.maxConsecutiveFailures ?? 3)) {
        this.degraded = true;
        this.logger?.warn(
          { consecutiveFailures: this.consecutiveFailures },
          'trace store degraded: further trace writes will be dropped until restart',
        );
      }
    }
  }

  summary(query: TraceQuery): SummaryData {
    this.flush();
    return this.storage.summary(query);
  }

  listRuns(query: RunQuery): RunListResult {
    this.flush();
    return this.storage.listRuns(query);
  }

  getRun(runId: string): RunDetail | undefined {
    this.flush();
    return this.storage.getRun(runId);
  }

  prune(before: number): number {
    this.flush();
    return this.storage.prune(before);
  }

  close(): void {
    this.flush();
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.storage.close();
  }

  stats(): TraceStoreStats {
    return {
      mode: this.mode,
      pending: this.pending.length,
      recorded: this.recorded,
      flushed: this.flushed,
      dropped: this.dropped,
      failedFlushes: this.failedFlushes,
      degraded: this.degraded,
      lastFlushMs: Math.round(this.lastFlushMs * 100) / 100,
    };
  }

  private enqueue(op: TraceOp): void {
    if (this.closed || this.degraded) {
      this.dropped += 1;
      return;
    }
    this.recorded += 1;
    this.pending.push(op);
    // 队列有硬上限：丢最旧的（数据损失只发生在后端连续失败/极高速率时，且可观测）。
    while (this.pending.length > this.options.maxPending) {
      this.pending.shift();
      this.dropped += 1;
    }
    if (this.pending.length >= this.options.batchSize) this.flush();
  }
}

/** trace 关闭时的空实现：写入丢弃，读取返回空结构（REST 契约保持不变）。 */
export class NullTraceRepository implements TraceRepository {
  startRun(): void {}
  finishRun(): void {}
  addStep(): void {}
  flush(): void {}
  close(): void {}

  summary(): SummaryData {
    return emptySummary();
  }

  listRuns(): RunListResult {
    return { runs: [] };
  }

  getRun(): undefined {
    return undefined;
  }

  prune(): number {
    return 0;
  }

  stats(): TraceStoreStats {
    return {
      mode: 'off',
      pending: 0,
      recorded: 0,
      flushed: 0,
      dropped: 0,
      failedFlushes: 0,
      degraded: false,
      lastFlushMs: 0,
    };
  }
}

/** 空聚合结构（NullTraceRepository 与测试共用）。 */
export function emptySummary(): SummaryData {
  return {
    totals: {
      runs: 0,
      errorRuns: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      durationSamples: [],
      ttftSamples: [],
    },
    byModel: [],
    byTool: [],
    byApproval: [],
    daily: [],
  };
}

/** 供内存后端复用：按条件筛 run（时间窗口 / cwd / 会话 / 任务）。 */
export function matchesQuery(
  run: RunRow,
  query: TraceQuery & { sessionId?: string; taskId?: string },
): boolean {
  if (query.from !== undefined && run.startedAt < query.from) return false;
  if (query.to !== undefined && run.startedAt >= query.to) return false;
  if (query.cwd !== undefined && run.cwd !== query.cwd) return false;
  if (query.sessionId !== undefined && run.sessionId !== query.sessionId) return false;
  if (query.taskId !== undefined && run.taskId !== query.taskId) return false;
  return true;
}

/**
 * 供内存后端复用：按「startedAt desc, id desc」排序 + 游标分页。
 * 中文说明：与 SQLite 后端的键集分页语义保持一致，避免两个实现结果不同。
 */
export function paginateRuns(
  runs: RunRow[],
  limit: number,
  cursor: string | undefined,
): RunListResult {
  const sorted = [...runs].sort(
    (left, right) => right.startedAt - left.startedAt || (right.id < left.id ? -1 : 1),
  );
  const after = decodeCursor(cursor);
  const filtered = after
    ? sorted.filter(
        (run) =>
          run.startedAt < after.startedAt ||
          (run.startedAt === after.startedAt && run.id < after.id),
      )
    : sorted;
  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > page.length;
  const last = page.at(-1);
  return { runs: page, ...(hasMore && last ? { nextCursor: `${last.startedAt}:${last.id}` } : {}) };
}

/** 供两个后端复用：把一步的统计写进工具预聚合（calls/errors/blocked/duration）。 */
export function toolRollupDelta(step: StepRow): {
  errors: number;
  blocked: number;
  durationMs: number;
} {
  return {
    errors: isRealError(step) ? 1 : 0,
    blocked: step.blockedBy === undefined ? 0 : 1,
    durationMs: step.durationMs ?? 0,
  };
}

/**
 * trace 的内存存储后端。
 *
 * 中文说明：用于 `PI_NODE_STORE=memory` 与单元测试（无盘环境、绝不允许触碰真实
 * `~/.pi`）。它与 SQLite 后端**保持同一套语义**：同样的预聚合表、同样的过滤条件、
 * 同样的分页与分位数采样口径，这样「内存模式」下的行为可以代表生产行为。
 * 因此这里维护聚合 map，而不是在读的时候全量重算。
 */

import {
  dayOf,
  isRealError,
  type RunQuery,
  type RunFinish,
  type RunRow,
  type StepRow,
  type TraceQuery,
} from './trace-model.js';
import {
  matchesQuery,
  paginateRuns,
  type ApprovalAggregate,
  type DailyAggregate,
  type ModelAggregate,
  type RunDetail,
  type RunListResult,
  type SummaryData,
  type ToolAggregate,
  type TraceOp,
  type TraceStorage,
} from './trace-repository.js';
import { DEFAULT_SAMPLE_LIMIT } from './sqlite-trace-storage.js';

interface RunRollup {
  day: string;
  cwd: string;
  provider: string;
  model: string;
  runs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  errors: number;
}

interface ToolRollup {
  day: string;
  cwd: string;
  toolName: string;
  calls: number;
  errors: number;
  blocked: number;
  durationMsSum: number;
}

interface ApprovalRollup {
  day: string;
  cwd: string;
  rule: string;
  risk: string;
  approved: number;
  denied: number;
  timedOut: number;
  waitMsSum: number;
}

/** 聚合过滤（与 SQL 后端的 rollupFilter 语义一致：day + cwd）。 */
function matchesRollup(query: TraceQuery, day: string, cwd: string): boolean {
  if (query.from !== undefined && day < dayOf(query.from)) return false;
  if (query.to !== undefined && day > dayOf(Math.max(0, query.to - 1))) return false;
  if (query.cwd !== undefined && cwd !== query.cwd) return false;
  return true;
}

/** 明细样本过滤（与 SQL 后端的 runFilter 一致）。 */
function matchesStep(query: TraceQuery, step: StepRow, runCwd: string | undefined): boolean {
  if (query.from !== undefined && step.startedAt < query.from) return false;
  if (query.to !== undefined && step.startedAt >= query.to) return false;
  if (query.cwd !== undefined && runCwd !== query.cwd) return false;
  return true;
}

/** 内存存储后端。 */
export class MemoryTraceStorage implements TraceStorage {
  private readonly runs = new Map<string, RunRow>();
  private readonly steps: StepRow[] = [];
  private readonly runRollups = new Map<string, RunRollup>();
  private readonly toolRollups = new Map<string, ToolRollup>();
  private readonly approvalRollups = new Map<string, ApprovalRollup>();
  private closed = false;

  apply(ops: readonly TraceOp[]): void {
    if (this.closed) return;
    for (const op of ops) {
      if (op.op === 'run_start') this.startRun(op.run);
      else if (op.op === 'run_finish') this.finishRun(op.runId, op.patch);
      else this.addStep(op.step);
    }
  }

  summary(query: TraceQuery): SummaryData {
    const sampleLimit = Math.min(Math.max(query.sampleLimit ?? DEFAULT_SAMPLE_LIMIT, 1), 10_000);
    const runs = [...this.runs.values()].filter((run) => matchesQuery(run, query));
    const rollups = [...this.runRollups.values()].filter((rollup) =>
      matchesRollup(query, rollup.day, rollup.cwd),
    );
    // 计数/成本/token 来自预聚合（天 + cwd 分辨率），所以清理明细后历史口径仍完整。
    const totals = {
      runs: sum(rollups, (rollup) => rollup.runs),
      errorRuns: sum(rollups, (rollup) => rollup.errors),
      turns: sum(rollups, (rollup) => rollup.turns),
      inputTokens: sum(rollups, (rollup) => rollup.inputTokens),
      outputTokens: sum(rollups, (rollup) => rollup.outputTokens),
      cacheReadTokens: sum(rollups, (rollup) => rollup.cacheReadTokens),
      costUsd: sum(rollups, (rollup) => rollup.costUsd),
      // 分位数是唯一走明细的部分（范围内最近 N 条样本）。
      durationSamples: samples(
        runs.filter((run) => run.durationMs !== undefined),
        (run) => run.durationMs!,
        sampleLimit,
      ),
      ttftSamples: samples(
        runs.filter((run) => run.ttftMs !== undefined),
        (run) => run.ttftMs!,
        sampleLimit,
      ),
    };
    return {
      totals,
      byModel: this.modelAggregates(rollups, runs, sampleLimit),
      byTool: this.toolAggregates(query, sampleLimit),
      byApproval: this.approvalAggregates(query, sampleLimit),
      daily: this.dailyAggregates(rollups),
    };
  }

  listRuns(query: RunQuery): RunListResult {
    const matched = [...this.runs.values()].filter((run) => matchesQuery(run, query));
    return paginateRuns(matched, query.limit, query.cursor);
  }

  getRun(runId: string): RunDetail | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return {
      run,
      steps: this.steps.filter((step) => step.runId === runId).sort(byStartedAt),
      children: [...this.runs.values()]
        .filter((child) => child.parentRunId === runId)
        .sort(byStartedAt),
    };
  }

  /** 与 SQL 后端一致：只删明细，预聚合保留。 */
  prune(before: number): number {
    let deleted = 0;
    for (const [id, run] of [...this.runs]) {
      if (run.startedAt < before) {
        this.runs.delete(id);
        deleted += 1;
      }
    }
    for (let index = this.steps.length - 1; index >= 0; index -= 1) {
      if (this.steps[index].startedAt < before) this.steps.splice(index, 1);
    }
    return deleted;
  }

  close(): void {
    this.closed = true;
  }

  // ---- 写入 ----

  private startRun(run: RunRow): void {
    if (!this.runs.has(run.id)) this.runs.set(run.id, { ...run });
  }

  private finishRun(runId: string, patch: RunFinish): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;
    // meta 未提供时保留原值：run 开始时的元信息（如子会话的 preset/depth）不该被收尾抹掉。
    const { meta, ...rest } = patch;
    Object.assign(run, rest);
    if (meta !== undefined) run.meta = meta;
    const day = dayOf(run.startedAt);
    // provider/model 用空串代替缺失，与 SQL 后端保持一致。
    const key = `${day}|${run.cwd}|${run.provider ?? ''}|${run.model ?? ''}`;
    const rollup = this.runRollups.get(key) ?? {
      day,
      cwd: run.cwd,
      provider: run.provider ?? '',
      model: run.model ?? '',
      runs: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      errors: 0,
    };
    rollup.runs += 1;
    rollup.turns += patch.turns;
    rollup.inputTokens += patch.inputTokens;
    rollup.outputTokens += patch.outputTokens;
    rollup.cacheReadTokens += patch.cacheReadTokens;
    rollup.costUsd += patch.costUsd;
    rollup.errors += patch.status === 'error' ? 1 : 0;
    this.runRollups.set(key, rollup);
  }

  private addStep(step: StepRow): void {
    this.steps.push(step);
    const cwd = this.runs.get(step.runId)?.cwd;
    if (cwd === undefined) return;
    const day = dayOf(step.startedAt);
    if (step.kind === 'tool_call' && step.toolName !== undefined) {
      const key = `${day}|${cwd}|${step.toolName}`;
      const rollup = this.toolRollups.get(key) ?? {
        day,
        cwd,
        toolName: step.toolName,
        calls: 0,
        errors: 0,
        blocked: 0,
        durationMsSum: 0,
      };
      rollup.calls += 1;
      rollup.errors += isRealError(step) ? 1 : 0;
      rollup.blocked += step.blockedBy === undefined ? 0 : 1;
      rollup.durationMsSum += step.durationMs ?? 0;
      this.toolRollups.set(key, rollup);
    } else if (step.kind === 'approval' && step.approvalRule !== undefined) {
      const risk = step.approvalRisk ?? 'unknown';
      const key = `${day}|${cwd}|${step.approvalRule}|${risk}`;
      const rollup = this.approvalRollups.get(key) ?? {
        day,
        cwd,
        rule: step.approvalRule,
        risk,
        approved: 0,
        denied: 0,
        timedOut: 0,
        waitMsSum: 0,
      };
      if (step.approvalDecision === 'approved') rollup.approved += 1;
      else if (step.approvalDecision === 'denied') rollup.denied += 1;
      else if (step.approvalDecision === 'timed_out') rollup.timedOut += 1;
      rollup.waitMsSum += step.approvalWaitMs ?? 0;
      this.approvalRollups.set(key, rollup);
    }
  }

  // ---- 聚合读取 ----

  private modelAggregates(
    rollups: RunRollup[],
    runs: RunRow[],
    sampleLimit: number,
  ): ModelAggregate[] {
    const groups = new Map<string, { provider?: string; model?: string; runs: RunRollup[] }>();
    for (const rollup of rollups) {
      const key = `${rollup.provider}|${rollup.model}`;
      const group = groups.get(key) ?? {
        provider: rollup.provider || undefined,
        model: rollup.model || undefined,
        runs: [],
      };
      group.runs.push(rollup);
      groups.set(key, group);
    }
    return [...groups.values()]
      .map((group) => {
        const matching = runs.filter(
          (run) =>
            (run.provider ?? '') === (group.provider ?? '') &&
            (run.model ?? '') === (group.model ?? ''),
        );
        return {
          provider: group.provider,
          model: group.model,
          runs: sum(group.runs, (item) => item.runs),
          costUsd: sum(group.runs, (item) => item.costUsd),
          tokens: sum(group.runs, (item) => item.inputTokens + item.outputTokens),
          durationSamples: samples(
            matching.filter((run) => run.durationMs !== undefined),
            (run) => run.durationMs!,
            sampleLimit,
          ),
        };
      })
      .sort(
        (left, right) =>
          right.runs - left.runs ||
          compareText(left.provider ?? '', right.provider ?? '') ||
          compareText(left.model ?? '', right.model ?? ''),
      );
  }

  private toolAggregates(query: TraceQuery, sampleLimit: number): ToolAggregate[] {
    const groups = new Map<string, ToolAggregate>();
    for (const rollup of this.toolRollups.values()) {
      if (!matchesRollup(query, rollup.day, rollup.cwd)) continue;
      const aggregate = groups.get(rollup.toolName) ?? {
        toolName: rollup.toolName,
        calls: 0,
        errors: 0,
        blocked: 0,
        durationMsSum: 0,
        durationSamples: [],
      };
      aggregate.calls += rollup.calls;
      aggregate.errors += rollup.errors;
      aggregate.blocked += rollup.blocked;
      aggregate.durationMsSum += rollup.durationMsSum;
      groups.set(rollup.toolName, aggregate);
    }
    for (const aggregate of groups.values()) {
      aggregate.durationSamples = samples(
        this.steps.filter(
          (step) =>
            step.kind === 'tool_call' &&
            step.toolName === aggregate.toolName &&
            step.durationMs !== undefined &&
            matchesStep(query, step, this.runs.get(step.runId)?.cwd),
        ),
        (step) => step.durationMs!,
        sampleLimit,
      );
    }
    return [...groups.values()].sort(
      (left, right) => right.calls - left.calls || compareText(left.toolName, right.toolName),
    );
  }

  private approvalAggregates(query: TraceQuery, sampleLimit: number): ApprovalAggregate[] {
    const groups = new Map<string, ApprovalAggregate>();
    for (const rollup of this.approvalRollups.values()) {
      if (!matchesRollup(query, rollup.day, rollup.cwd)) continue;
      const key = `${rollup.rule}|${rollup.risk}`;
      const aggregate = groups.get(key) ?? {
        rule: rollup.rule,
        risk: rollup.risk,
        approved: 0,
        denied: 0,
        timedOut: 0,
        waitMsSum: 0,
        waitSamples: [],
      };
      aggregate.approved += rollup.approved;
      aggregate.denied += rollup.denied;
      aggregate.timedOut += rollup.timedOut;
      aggregate.waitMsSum += rollup.waitMsSum;
      groups.set(key, aggregate);
    }
    for (const aggregate of groups.values()) {
      aggregate.waitSamples = samples(
        this.steps.filter(
          (step) =>
            step.kind === 'approval' &&
            step.approvalRule === aggregate.rule &&
            (step.approvalRisk ?? 'unknown') === aggregate.risk &&
            step.approvalWaitMs !== undefined &&
            matchesStep(query, step, this.runs.get(step.runId)?.cwd),
        ),
        (step) => step.approvalWaitMs!,
        sampleLimit,
      );
    }
    return [...groups.values()].sort(
      (left, right) =>
        right.approved +
          right.denied +
          right.timedOut -
          (left.approved + left.denied + left.timedOut) ||
        compareText(left.rule, right.rule) ||
        compareText(left.risk, right.risk),
    );
  }

  private dailyAggregates(rollups: RunRollup[]): DailyAggregate[] {
    const days = new Map<string, DailyAggregate>();
    for (const rollup of rollups) {
      const aggregate = days.get(rollup.day) ?? {
        date: rollup.day,
        runs: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      aggregate.runs += rollup.runs;
      aggregate.costUsd += rollup.costUsd;
      aggregate.inputTokens += rollup.inputTokens;
      aggregate.outputTokens += rollup.outputTokens;
      days.set(rollup.day, aggregate);
    }
    return [...days.values()].sort((left, right) => (left.date < right.date ? -1 : 1));
  }
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

/** 取最近 sampleLimit 条样本的原始值（与 SQL 后端的 `ORDER BY started_at DESC LIMIT ?` 等价）。 */
function samples<T extends { startedAt: number }>(
  items: T[],
  pick: (item: T) => number,
  limit: number,
): number[] {
  return [...items]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, limit)
    .map(pick);
}

function byStartedAt(left: { startedAt: number }, right: { startedAt: number }): number {
  return left.startedAt - right.startedAt;
}

/** 与 SQL 的 ORDER BY ... ASC 保持一致的字符串比较。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * trace 的 SQLite 存储后端。
 *
 * 中文说明：`node:sqlite` 的 DatabaseSync 是**同步 API**，会阻塞事件循环，所以本类
 * 只接受「批量 apply」——单条 record 不进这里（那是 QueuedTraceRepository 的职责）。
 * 实测 200 行一个事务的写入 p95 ≈ 0.65ms（spike/01-sqlite-p95.mjs），因此批量写不是瓶颈，
 * 真正的风险是**读路径的全表聚合**（20 万行 GROUP BY ≈ 96ms），所以聚合一律走
 * 写入时增量维护的预聚合表，明细表只用于「样本分位数」与单 run 下钻（都带 LIMIT）。
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { ServiceLogger } from '../service-logger.js';
import { applyMigrations, currentSchemaVersion } from './migrations.js';
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

/** 分位数样本上限的默认值（超出则只取范围内最近 N 条，属于有界近似）。 */
export const DEFAULT_SAMPLE_LIMIT = 2000;

/** node:sqlite 只接受这些类型作为绑定值（boolean 会直接抛错）。 */
type BindValue = null | number | bigint | string;

/** 把可选值统一成绑定值（undefined → null）。 */
function bind(value: string | number | undefined | null): BindValue {
  return value === undefined ? null : value;
}

function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' || typeof value === 'bigint'
    ? Number(value)
    : value === null || value === undefined
      ? undefined
      : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** TEXT 列里存的 JSON（meta）→ 对象；解析失败不影响读取。 */
function parseMeta(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 构造 WHERE 片段与参数：runs 表按时间窗口 / cwd / 会话 / 任务过滤。 */
function runFilter(query: TraceQuery & { sessionId?: string; taskId?: string }): {
  sql: string;
  params: BindValue[];
} {
  const conditions: string[] = [];
  const params: BindValue[] = [];
  if (query.from !== undefined) {
    conditions.push('started_at >= ?');
    params.push(query.from);
  }
  if (query.to !== undefined) {
    conditions.push('started_at < ?');
    params.push(query.to);
  }
  if (query.cwd !== undefined) {
    conditions.push('cwd = ?');
    params.push(query.cwd);
  }
  if (query.sessionId !== undefined) {
    conditions.push('session_id = ?');
    params.push(query.sessionId);
  }
  if (query.taskId !== undefined) {
    conditions.push('task_id = ?');
    params.push(query.taskId);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** 预聚合表的过滤条件：按日期分桶 + cwd（聚合表没有更细的时间分辨率）。 */
function rollupFilter(query: TraceQuery): { sql: string; params: BindValue[] } {
  const conditions: string[] = [];
  const params: BindValue[] = [];
  if (query.from !== undefined) {
    conditions.push('day >= ?');
    params.push(dayOf(query.from));
  }
  if (query.to !== undefined) {
    // to 是开区间：最后一天取 to-1 所在的日期。
    conditions.push('day <= ?');
    params.push(dayOf(Math.max(0, query.to - 1)));
  }
  if (query.cwd !== undefined) {
    conditions.push('cwd = ?');
    params.push(query.cwd);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** SQLite 存储后端：批量落库 + 预聚合 + 有界明细查询。 */
export class SqliteTraceStorage implements TraceStorage {
  private readonly statements = new Map<string, StatementSync>();
  /** 一个批次内 runId → cwd 的缓存，避免每个 step 都多查一次 runs。 */
  private readonly runCwdCache = new Map<string, string | undefined>();
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly logger?: ServiceLogger,
  ) {
    // WAL：读写不互相阻塞；NORMAL 同步级别在 WAL 下已足够安全且写入更快。
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 3000');
    applyMigrations(db, undefined, logger);
  }

  /** 打开（或创建）指定路径的库文件。 */
  static open(dbPath: string, logger?: ServiceLogger): SqliteTraceStorage {
    return new SqliteTraceStorage(new DatabaseSync(dbPath), logger);
  }

  get schemaVersion(): number {
    return currentSchemaVersion(this.db);
  }

  /** 批量写入：整批一个事务，失败整体回滚（由调用方决定丢弃策略）。 */
  apply(ops: readonly TraceOp[]): void {
    if (this.closed) return;
    this.runCwdCache.clear();
    this.db.exec('BEGIN');
    try {
      for (const op of ops) {
        if (op.op === 'run_start') this.insertRun(op.run);
        else if (op.op === 'run_finish') this.updateRun(op.runId, op.patch);
        else this.insertStep(op.step);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  summary(query: TraceQuery): SummaryData {
    const filter = runFilter(query);
    const rollups = rollupFilter(query);
    const sample = Math.min(Math.max(query.sampleLimit ?? DEFAULT_SAMPLE_LIMIT, 1), 10_000);
    // 计数/成本/token 一律来自预聚合表（天 + cwd 分辨率），因此清理明细后历史口径仍完整。
    const totalsRow = this.statement(
      `SELECT SUM(runs) AS runs,
              SUM(errors) AS errorRuns,
              SUM(turns) AS turns,
              SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens,
              SUM(cache_read_tokens) AS cacheReadTokens,
              SUM(cost_usd) AS costUsd
       FROM run_rollups ${rollups.sql}`,
    ).get(...rollups.params);
    const totals = {
      runs: toNumber(totalsRow?.runs),
      errorRuns: toNumber(totalsRow?.errorRuns),
      turns: toNumber(totalsRow?.turns),
      inputTokens: toNumber(totalsRow?.inputTokens),
      outputTokens: toNumber(totalsRow?.outputTokens),
      cacheReadTokens: toNumber(totalsRow?.cacheReadTokens),
      costUsd: toNumber(totalsRow?.costUsd),
      // 分位数是唯一走明细表的部分：范围内最近 N 条样本（有界索引扫描）。
      durationSamples: this.sampleRuns('duration_ms', filter, sample),
      ttftSamples: this.sampleRuns('ttft_ms', filter, sample),
    };
    return {
      totals,
      byModel: this.modelAggregates(rollups, filter, sample),
      byTool: this.toolAggregates(query, sample),
      byApproval: this.approvalAggregates(query, sample),
      daily: this.dailyAggregates(rollups),
    };
  }

  listRuns(query: RunQuery): RunListResult {
    const filter = runFilter(query);
    const conditions = filter.sql ? [filter.sql.slice('WHERE '.length)] : [];
    const params = [...filter.params];
    // 键集分页：游标＝(started_at, id)，避免 OFFSET 越翻越慢。
    if (query.cursor) {
      const index = query.cursor.indexOf(':');
      const cursorAt = Number(query.cursor.slice(0, index));
      const cursorId = query.cursor.slice(index + 1);
      if (Number.isFinite(cursorAt) && cursorId) {
        conditions.push('(started_at < ? OR (started_at = ? AND id < ?))');
        params.push(cursorAt, cursorAt, cursorId);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.statement(
      `SELECT * FROM runs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`,
    ).all(...params, query.limit + 1);
    const runs = rows.map((row) => this.toRunRow(row));
    const page = runs.slice(0, query.limit);
    const last = page.at(-1);
    // 多取一条判断是否还有下一页（比 COUNT(*) 便宜）。
    return {
      runs: page,
      ...(runs.length > page.length && last ? { nextCursor: `${last.startedAt}:${last.id}` } : {}),
    };
  }

  getRun(runId: string): RunDetail | undefined {
    const row = this.statement('SELECT * FROM runs WHERE id = ?').get(runId);
    if (row === undefined) return undefined;
    const steps = this.statement(
      'SELECT * FROM steps WHERE run_id = ? ORDER BY started_at ASC, id ASC',
    ).all(runId);
    const children = this.statement(
      'SELECT * FROM runs WHERE parent_run_id = ? ORDER BY started_at ASC',
    ).all(runId);
    return {
      run: this.toRunRow(row),
      steps: steps.map((step) => this.toStepRow(step)),
      children: children.map((child) => this.toRunRow(child)),
    };
  }

  /**
   * 删除明细。
   * 中文说明：**预聚合表不动**——rollup 是长期聚合历史，明细是可清理的运行细节。
   * 因此清理后 Dashboard 的累计口径仍完整，只是下钻不到被清理的 run。
   */
  prune(before: number): number {
    this.db.exec('BEGIN');
    try {
      this.statement('DELETE FROM steps WHERE started_at < ?').run(before);
      const deleted = this.statement('DELETE FROM runs WHERE started_at < ?').run(before);
      this.db.exec('COMMIT');
      return toNumber(deleted.changes);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  // ---- 写入：明细 + 预聚合（同一事务内完成，保证读到的聚合不会落后于明细） ----

  private insertRun(run: RunRow): void {
    this.statement(
      `INSERT INTO runs (id, session_id, parent_run_id, task_id, cwd, provider, model,
          thinking_level, started_at, ended_at, status, stop_reason, error_type, error_message,
          turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
          ttft_ms, duration_ms, meta, day)
       VALUES (:id, :sessionId, :parentRunId, :taskId, :cwd, :provider, :model,
          :thinkingLevel, :startedAt, :endedAt, :status, :stopReason, :errorType, :errorMessage,
          :turns, :inputTokens, :outputTokens, :cacheReadTokens, :cacheWriteTokens, :costUsd,
          :ttftMs, :durationMs, :meta, :day)
       ON CONFLICT(id) DO NOTHING`,
    ).run({
      id: run.id,
      sessionId: run.sessionId,
      parentRunId: bind(run.parentRunId),
      taskId: bind(run.taskId),
      cwd: run.cwd,
      provider: bind(run.provider),
      model: bind(run.model),
      thinkingLevel: bind(run.thinkingLevel),
      startedAt: run.startedAt,
      endedAt: bind(run.endedAt),
      status: run.status,
      stopReason: bind(run.stopReason),
      errorType: bind(run.errorType),
      errorMessage: bind(run.errorMessage),
      turns: run.turns,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
      costUsd: run.costUsd,
      ttftMs: bind(run.ttftMs),
      durationMs: bind(run.durationMs),
      meta: run.meta === undefined ? null : JSON.stringify(run.meta),
      day: dayOf(run.startedAt),
    });
    this.runCwdCache.set(run.id, run.cwd);
  }

  private updateRun(runId: string, patch: RunFinish): void {
    const row = this.statement(
      `SELECT started_at AS startedAt, cwd AS cwd, status AS status,
              provider AS provider, model AS model
       FROM runs WHERE id = ?`,
    ).get(runId);
    this.statement(
      `UPDATE runs SET ended_at = :endedAt, status = :status, stop_reason = :stopReason,
          error_type = :errorType, error_message = :errorMessage, turns = :turns,
          input_tokens = :inputTokens, output_tokens = :outputTokens,
          cache_read_tokens = :cacheReadTokens, cache_write_tokens = :cacheWriteTokens,
          cost_usd = :costUsd, ttft_ms = :ttftMs, duration_ms = :durationMs, meta = :meta
       WHERE id = :id`,
    ).run({
      id: runId,
      endedAt: bind(patch.endedAt),
      status: patch.status,
      stopReason: bind(patch.stopReason),
      errorType: bind(patch.errorType),
      errorMessage: bind(patch.errorMessage),
      turns: patch.turns,
      inputTokens: patch.inputTokens,
      outputTokens: patch.outputTokens,
      cacheReadTokens: patch.cacheReadTokens,
      cacheWriteTokens: patch.cacheWriteTokens,
      costUsd: patch.costUsd,
      ttftMs: bind(patch.ttftMs),
      durationMs: bind(patch.durationMs),
      meta: patch.meta === undefined ? null : JSON.stringify(patch.meta),
    });
    // run 只在第一次进入终态时计入聚合，避免重复 finish 造成重复计数。
    const previous = optionalString(row?.status);
    const startedAt = optionalNumber(row?.startedAt);
    if (startedAt === undefined || previous !== 'running') return;
    const cwd = optionalString(row?.cwd) ?? '';
    // provider/model 在聚合表里用空串代替 NULL：SQLite 的 UNIQUE 把 NULL 视作互不相等，
    // 直接存 NULL 会让 ON CONFLICT 匹配不上而写成多行。
    this.statement(
      `INSERT INTO run_rollups (day, cwd, provider, model, runs, turns, input_tokens,
          output_tokens, cache_read_tokens, cost_usd, errors)
       VALUES (:day, :cwd, :provider, :model, 1, :turns, :inputTokens, :outputTokens,
          :cacheReadTokens, :costUsd, :errors)
       ON CONFLICT(day, cwd, provider, model) DO UPDATE SET
          runs = runs + 1,
          turns = turns + excluded.turns,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
          cost_usd = cost_usd + excluded.cost_usd,
          errors = errors + excluded.errors`,
    ).run({
      day: dayOf(startedAt),
      cwd,
      provider: optionalString(row?.provider) ?? '',
      model: optionalString(row?.model) ?? '',
      turns: patch.turns,
      inputTokens: patch.inputTokens,
      outputTokens: patch.outputTokens,
      cacheReadTokens: patch.cacheReadTokens,
      costUsd: patch.costUsd,
      errors: patch.status === 'error' ? 1 : 0,
    });
  }

  private insertStep(step: StepRow): void {
    this.statement(
      `INSERT INTO steps (run_id, session_id, turn_index, kind, tool_name, tool_call_id,
          started_at, ended_at, duration_ms, is_error, blocked_by, error_type, error_message,
          args_digest, args_bytes, result_digest, result_bytes, approval_rule, approval_risk,
          approval_decision, approval_wait_ms, decided_by, meta, day)
       VALUES (:runId, :sessionId, :turnIndex, :kind, :toolName, :toolCallId,
          :startedAt, :endedAt, :durationMs, :isError, :blockedBy, :errorType, :errorMessage,
          :argsDigest, :argsBytes, :resultDigest, :resultBytes, :approvalRule, :approvalRisk,
          :approvalDecision, :approvalWaitMs, :decidedBy, :meta, :day)`,
    ).run({
      runId: step.runId,
      sessionId: step.sessionId,
      turnIndex: step.turnIndex,
      kind: step.kind,
      toolName: bind(step.toolName),
      toolCallId: bind(step.toolCallId),
      startedAt: step.startedAt,
      endedAt: bind(step.endedAt),
      durationMs: bind(step.durationMs),
      isError: step.isError ? 1 : 0,
      blockedBy: bind(step.blockedBy),
      errorType: bind(step.errorType),
      errorMessage: bind(step.errorMessage),
      argsDigest: bind(step.argsDigest),
      argsBytes: bind(step.argsBytes),
      resultDigest: bind(step.resultDigest),
      resultBytes: bind(step.resultBytes),
      approvalRule: bind(step.approvalRule),
      approvalRisk: bind(step.approvalRisk),
      approvalDecision: bind(step.approvalDecision),
      approvalWaitMs: bind(step.approvalWaitMs),
      decidedBy: bind(step.decidedBy),
      meta: step.meta === undefined ? null : JSON.stringify(step.meta),
      day: dayOf(step.startedAt),
    });
    const cwd = this.cwdOfRun(step.runId);
    if (cwd === undefined) return; // 明细先于 run_start 到达时不计入聚合（极端情况）
    if (step.kind === 'tool_call' && step.toolName !== undefined) {
      this.statement(
        `INSERT INTO tool_rollups (day, cwd, tool_name, calls, errors, blocked, duration_ms_sum)
         VALUES (:day, :cwd, :toolName, 1, :errors, :blocked, :durationMs)
         ON CONFLICT(day, cwd, tool_name) DO UPDATE SET
            calls = calls + 1,
            errors = errors + excluded.errors,
            blocked = blocked + excluded.blocked,
            duration_ms_sum = duration_ms_sum + excluded.duration_ms_sum`,
      ).run({
        day: dayOf(step.startedAt),
        cwd,
        toolName: step.toolName,
        errors: isRealError(step) ? 1 : 0,
        blocked: step.blockedBy === undefined ? 0 : 1,
        durationMs: step.durationMs ?? 0,
      });
    } else if (step.kind === 'approval' && step.approvalRule !== undefined) {
      this.statement(
        `INSERT INTO approval_rollups (day, cwd, rule, risk, approved, denied, timed_out, wait_ms_sum)
         VALUES (:day, :cwd, :rule, :risk, :approved, :denied, :timedOut, :waitMs)
         ON CONFLICT(day, cwd, rule, risk) DO UPDATE SET
            approved = approved + excluded.approved,
            denied = denied + excluded.denied,
            timed_out = timed_out + excluded.timed_out,
            wait_ms_sum = wait_ms_sum + excluded.wait_ms_sum`,
      ).run({
        day: dayOf(step.startedAt),
        cwd,
        rule: step.approvalRule,
        risk: step.approvalRisk ?? 'unknown',
        approved: step.approvalDecision === 'approved' ? 1 : 0,
        denied: step.approvalDecision === 'denied' ? 1 : 0,
        timedOut: step.approvalDecision === 'timed_out' ? 1 : 0,
        waitMs: step.approvalWaitMs ?? 0,
      });
    }
  }

  private cwdOfRun(runId: string): string | undefined {
    if (this.runCwdCache.has(runId)) return this.runCwdCache.get(runId);
    const row = this.statement('SELECT cwd FROM runs WHERE id = ?').get(runId);
    const cwd = optionalString(row?.cwd);
    this.runCwdCache.set(runId, cwd);
    return cwd;
  }

  // ---- 读：有界样本 + 预聚合 ----

  private sampleRuns(
    column: 'duration_ms' | 'ttft_ms',
    filter: { sql: string; params: BindValue[] },
    limit: number,
  ): number[] {
    const rows = this.statement(
      `SELECT ${column} AS value FROM runs ${filter.sql ? `${filter.sql} AND` : 'WHERE'} ${column} IS NOT NULL
       ORDER BY started_at DESC LIMIT ?`,
    ).all(...filter.params, limit);
    return rows.map((row) => toNumber(row.value));
  }

  private modelAggregates(
    rollups: { sql: string; params: BindValue[] },
    filter: { sql: string; params: BindValue[] },
    sampleLimit: number,
  ): ModelAggregate[] {
    const rows = this.statement(
      `SELECT provider, model, SUM(runs) AS runs, SUM(cost_usd) AS costUsd,
              SUM(input_tokens + output_tokens) AS tokens
       FROM run_rollups ${rollups.sql}
       GROUP BY provider, model
       ORDER BY runs DESC, provider ASC, model ASC`,
    ).all(...rollups.params);
    return rows.map((row) => {
      // 空串在聚合表里代表「未指定」，对外仍还原为缺失。
      const provider = optionalString(row.provider) || undefined;
      const model = optionalString(row.model) || undefined;
      const samples = this.statement(
        `SELECT duration_ms AS value FROM runs
         ${filter.sql ? `${filter.sql} AND` : 'WHERE'} provider IS ? AND model IS ? AND duration_ms IS NOT NULL
         ORDER BY started_at DESC LIMIT ?`,
      ).all(...filter.params, bind(provider), bind(model), sampleLimit);
      return {
        provider,
        model,
        runs: toNumber(row.runs),
        costUsd: toNumber(row.costUsd),
        tokens: toNumber(row.tokens),
        durationSamples: samples.map((item) => toNumber(item.value)),
      };
    });
  }

  private toolAggregates(query: TraceQuery, sampleLimit: number): ToolAggregate[] {
    const filter = rollupFilter(query);
    const rows = this.statement(
      `SELECT tool_name AS toolName, SUM(calls) AS calls, SUM(errors) AS errors,
              SUM(blocked) AS blocked, SUM(duration_ms_sum) AS durationMsSum
       FROM tool_rollups ${filter.sql}
       GROUP BY tool_name
       ORDER BY calls DESC, tool_name ASC`,
    ).all(...filter.params);
    // 分位数样本：只取范围内最近 N 条（走 idx_steps_tool 的有界索引扫描，不扫全表）。
    const sampleStatement = this.statement(
      `SELECT duration_ms AS value FROM steps
       WHERE kind = 'tool_call' AND tool_name = ?
         AND (? IS NULL OR started_at >= ?) AND (? IS NULL OR started_at < ?)
         AND (? IS NULL OR run_id IN (SELECT id FROM runs WHERE cwd = ?))
       ORDER BY started_at DESC LIMIT ?`,
    );
    return rows.map((row) => {
      const toolName = optionalString(row.toolName) ?? '';
      const samples = sampleStatement.all(
        toolName,
        bind(query.from),
        bind(query.from),
        bind(query.to),
        bind(query.to),
        bind(query.cwd),
        bind(query.cwd),
        sampleLimit,
      );
      return {
        toolName,
        calls: toNumber(row.calls),
        errors: toNumber(row.errors),
        blocked: toNumber(row.blocked),
        durationMsSum: toNumber(row.durationMsSum),
        durationSamples: samples.map((item) => toNumber(item.value)),
      };
    });
  }

  private approvalAggregates(query: TraceQuery, sampleLimit: number): ApprovalAggregate[] {
    const filter = rollupFilter(query);
    const rows = this.statement(
      `SELECT rule, risk, SUM(approved) AS approved, SUM(denied) AS denied,
              SUM(timed_out) AS timedOut, SUM(wait_ms_sum) AS waitMsSum
       FROM approval_rollups ${filter.sql}
       GROUP BY rule, risk
       ORDER BY (SUM(approved) + SUM(denied) + SUM(timed_out)) DESC, rule ASC, risk ASC`,
    ).all(...filter.params);
    const sampleStatement = this.statement(
      `SELECT approval_wait_ms AS value FROM steps
       WHERE kind = 'approval' AND approval_rule = ? AND approval_risk = ?
         AND (? IS NULL OR started_at >= ?) AND (? IS NULL OR started_at < ?)
         AND (? IS NULL OR run_id IN (SELECT id FROM runs WHERE cwd = ?))
       ORDER BY started_at DESC LIMIT ?`,
    );
    return rows.map((row) => {
      const rule = optionalString(row.rule) ?? '';
      const risk = optionalString(row.risk) ?? 'unknown';
      const samples = sampleStatement.all(
        rule,
        risk,
        bind(query.from),
        bind(query.from),
        bind(query.to),
        bind(query.to),
        bind(query.cwd),
        bind(query.cwd),
        sampleLimit,
      );
      return {
        rule,
        risk,
        approved: toNumber(row.approved),
        denied: toNumber(row.denied),
        timedOut: toNumber(row.timedOut),
        waitMsSum: toNumber(row.waitMsSum),
        waitSamples: samples
          .map((item) => optionalNumber(item.value))
          .filter((value): value is number => value !== undefined),
      };
    });
  }

  private dailyAggregates(rollups: { sql: string; params: BindValue[] }): DailyAggregate[] {
    const rows = this.statement(
      `SELECT day AS date, SUM(runs) AS runs, SUM(cost_usd) AS costUsd,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
       FROM run_rollups ${rollups.sql} GROUP BY day ORDER BY day ASC`,
    ).all(...rollups.params);
    return rows.map((row) => ({
      date: optionalString(row.date) ?? '',
      runs: toNumber(row.runs),
      costUsd: toNumber(row.costUsd),
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
    }));
  }

  private toRunRow(row: Record<string, unknown>): RunRow {
    return {
      id: optionalString(row.id) ?? '',
      sessionId: optionalString(row.session_id) ?? '',
      parentRunId: optionalString(row.parent_run_id),
      taskId: optionalString(row.task_id),
      cwd: optionalString(row.cwd) ?? '',
      provider: optionalString(row.provider),
      model: optionalString(row.model),
      thinkingLevel: optionalString(row.thinking_level),
      startedAt: toNumber(row.started_at),
      endedAt: optionalNumber(row.ended_at),
      status: (optionalString(row.status) ?? 'completed') as RunRow['status'],
      turns: toNumber(row.turns),
      inputTokens: toNumber(row.input_tokens),
      outputTokens: toNumber(row.output_tokens),
      cacheReadTokens: toNumber(row.cache_read_tokens),
      cacheWriteTokens: toNumber(row.cache_write_tokens),
      costUsd: toNumber(row.cost_usd),
      ttftMs: optionalNumber(row.ttft_ms),
      durationMs: optionalNumber(row.duration_ms),
      stopReason: optionalString(row.stop_reason),
      errorType: optionalString(row.error_type),
      errorMessage: optionalString(row.error_message),
      meta: parseMeta(row.meta),
    };
  }

  private toStepRow(row: Record<string, unknown>): StepRow {
    return {
      runId: optionalString(row.run_id) ?? '',
      sessionId: optionalString(row.session_id) ?? '',
      turnIndex: toNumber(row.turn_index),
      kind: (optionalString(row.kind) ?? 'llm_call') as StepRow['kind'],
      toolName: optionalString(row.tool_name),
      toolCallId: optionalString(row.tool_call_id),
      startedAt: toNumber(row.started_at),
      endedAt: optionalNumber(row.ended_at),
      durationMs: optionalNumber(row.duration_ms),
      isError: toNumber(row.is_error) === 1,
      blockedBy: optionalString(row.blocked_by) as StepRow['blockedBy'],
      errorType: optionalString(row.error_type),
      errorMessage: optionalString(row.error_message),
      argsDigest: optionalString(row.args_digest),
      argsBytes: optionalNumber(row.args_bytes),
      resultDigest: optionalString(row.result_digest),
      resultBytes: optionalNumber(row.result_bytes),
      approvalRule: optionalString(row.approval_rule),
      approvalRisk: optionalString(row.approval_risk),
      approvalDecision: optionalString(row.approval_decision) as StepRow['approvalDecision'],
      approvalWaitMs: optionalNumber(row.approval_wait_ms),
      decidedBy: optionalString(row.decided_by),
      meta: parseMeta(row.meta),
    };
  }

  /** 预编译语句缓存（同类 SQL 只 prepare 一次）。 */
  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    // 用「裸名字」绑定命名参数（SQL 里仍写 :name），少一层前缀转换。
    prepared.setAllowBareNamedParameters(true);
    this.statements.set(sql, prepared);
    return prepared;
  }
}

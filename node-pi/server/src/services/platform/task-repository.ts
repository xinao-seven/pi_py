/**
 * 任务的仓储层（M2）：SQLite 与内存双实现。
 *
 * 中文说明：与 trace 仓储的关键差异——**任务写入不走写入队列**。
 * trace 是「尽力而为的观测」（可丢、可降级、绝不影响主链路），而任务是用户可见的控制面：
 * 写入必须立刻持久化、失败必须冒泡成 API 错误、并发必须可判定。因此这里全部是同步 CRUD。
 *
 * 并发模型：`save()` 用「整条记录 + expectedRevision」写入，SQL 侧就是
 * `UPDATE ... SET revision = revision + 1 WHERE id = ? AND revision = ?`，
 * 再根据 `changes` 判定是否写入成功——这是单条语句的原子乐观锁，不需要额外的事务隔离级别。
 * 步骤表整批重写（任务步骤数量级是几十条，重写比增量 diff 更简单也更不容易错）。
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  sortSteps,
  type TaskQuery,
  type TaskRecord,
  type StepEvidence,
  type StepVerification,
  type TaskExecution,
  type TaskStep,
} from './task-model.js';

/** 列表默认/最大返回条数。 */
export const DEFAULT_TASK_LIMIT = 100;
export const MAX_TASK_LIMIT = 500;

/** 任务的持久化接口。 */
export interface TaskRepository {
  readonly kind: 'sqlite' | 'memory';
  get(id: string): TaskRecord | undefined;
  /** 按 updatedAt 倒序列出（过滤 status / sessionId / cwd）。 */
  list(query?: TaskQuery): TaskRecord[];
  /** 新建（revision 置 1）。 */
  insert(record: TaskRecord): void;
  /**
   * 乐观并发写入：整条记录写回（步骤整体替换）。
   * 返回 false 表示 revision 不匹配（调用方应回 409 task_conflict）。
   *
   * `keepRevision: true` 用于**执行期运行时写入**（租约/心跳/在飞动作）：
   * 它们照样落库，但**不占用版本号**——否则模型与面板手里的 revision 会被心跳持续顶掉，
   * 每次 update_plan / 面板编辑都变成「陈旧版本」（M4 eval 抓到的真实问题）。
   * 安全性前提：所有写入都经 `TaskService.mutate()` 重新读一次记录再改，
   * 因此不会用陈旧副本覆盖运行时字段。
   */
  save(record: TaskRecord, expectedRevision: number, options?: { keepRevision?: boolean }): boolean;
  /** 删除任务（M2 未开放 REST，供清理与测试使用）。 */
  remove(id: string): boolean;
  close(): void;
}

/** 从字符串里恢复 JSON（解析失败不影响读取，按缺失处理）。 */
function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function isoOf(value: unknown): string | undefined {
  return typeof value === 'number' ? new Date(value).toISOString() : undefined;
}

function epochOf(value: string | undefined): number | null {
  return value === undefined ? null : Date.parse(value);
}

/** SQLite 实现：与 trace 共用一个 DatabaseSync 连接（同一单线程内同步执行，不会交错）。 */
export class SqliteTaskRepository implements TaskRepository {
  readonly kind = 'sqlite' as const;
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  get(id: string): TaskRecord | undefined {
    const row = this.statement('SELECT * FROM tasks WHERE id = ?').get(id);
    if (row === undefined) return undefined;
    const steps = this.statement(
      'SELECT * FROM task_steps WHERE task_id = ? ORDER BY position ASC, id ASC',
    ).all(id);
    return toRecord(row, steps);
  }

  list(query: TaskQuery = {}): TaskRecord[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (query.status !== undefined) {
      conditions.push('t.status = ?');
      params.push(query.status);
    }
    if (query.sessionId !== undefined) {
      conditions.push('t.session_id = ?');
      params.push(query.sessionId);
    }
    if (query.cwd !== undefined) {
      conditions.push('t.cwd = ?');
      params.push(query.cwd);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_TASK_LIMIT, 1), MAX_TASK_LIMIT);
    const rows = this.statement(
      `SELECT * FROM tasks t ${where} ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`,
    ).all(...params, limit);
    if (rows.length === 0) return [];
    // 一次查完这些任务的所有步骤，再在内存里按 task_id 归组（避免 N+1）。
    const ids = rows.map((row) => String(row.id));
    const placeholders = ids.map(() => '?').join(', ');
    const stepRows = this.statement(
      `SELECT * FROM task_steps WHERE task_id IN (${placeholders}) ORDER BY task_id ASC, position ASC, id ASC`,
    ).all(...ids);
    const stepsByTask = new Map<string, Record<string, unknown>[]>();
    for (const step of stepRows) {
      const key = String(step.task_id);
      const list = stepsByTask.get(key) ?? [];
      list.push(step);
      stepsByTask.set(key, list);
    }
    return rows.map((row) => toRecord(row, stepsByTask.get(String(row.id)) ?? []));
  }

  insert(record: TaskRecord): void {
    this.db.exec('BEGIN');
    try {
      this.writeTask(record, record.revision, true);
      this.writeSteps(record);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  save(
    record: TaskRecord,
    expectedRevision: number,
    options: { keepRevision?: boolean } = {},
  ): boolean {
    this.db.exec('BEGIN');
    try {
      const applied = this.writeTask(
        record,
        expectedRevision,
        false,
        options.keepRevision === true,
      );
      if (!applied) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.writeSteps(record);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  remove(id: string): boolean {
    this.db.exec('BEGIN');
    try {
      this.statement('DELETE FROM task_steps WHERE task_id = ?').run(id);
      const result = this.statement('DELETE FROM tasks WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    // 连接由 PlatformStore 统一管理（与 trace 共用），这里不关闭。
    this.statements.clear();
  }

  /** 写入任务主表；返回是否真正写入（乐观锁判定）。 */
  private writeTask(
    record: TaskRecord,
    expectedRevision: number,
    isInsert: boolean,
    keepRevision = false,
  ): boolean {
    if (isInsert) {
      this.statement(
        `INSERT INTO tasks (id, title, goal, status, origin, session_id, cwd, revision,
            blocked_reason, conclusion, execution, created_at, updated_at)
         VALUES (:id, :title, :goal, :status, :origin, :sessionId, :cwd, :revision,
            :blockedReason, :conclusion, :execution, :createdAt, :updatedAt)`,
      ).run({
        id: record.id,
        title: record.title,
        goal: record.goal,
        status: record.status,
        origin: record.origin,
        sessionId: record.sessionId ?? null,
        cwd: record.cwd ?? null,
        revision: record.revision,
        blockedReason: record.blockedReason ?? null,
        conclusion: record.conclusion ?? null,
        execution: JSON.stringify(record.execution),
        createdAt: Date.parse(record.createdAt),
        updatedAt: Date.parse(record.updatedAt),
      });
      return true;
    }
    const result = this.statement(
      `UPDATE tasks SET title = :title, goal = :goal, status = :status, origin = :origin,
          session_id = :sessionId, cwd = :cwd,
          revision = CASE WHEN :keepRevision = 1 THEN revision ELSE revision + 1 END,
          blocked_reason = :blockedReason, conclusion = :conclusion, execution = :execution,
          updated_at = :updatedAt
       WHERE id = :id AND revision = :expectedRevision`,
    ).run({
      id: record.id,
      title: record.title,
      goal: record.goal,
      status: record.status,
      origin: record.origin,
      sessionId: record.sessionId ?? null,
      cwd: record.cwd ?? null,
      blockedReason: record.blockedReason ?? null,
      conclusion: record.conclusion ?? null,
      execution: JSON.stringify(record.execution),
      updatedAt: Date.parse(record.updatedAt),
      expectedRevision,
      keepRevision: keepRevision ? 1 : 0,
    });
    return Number(result.changes) > 0;
  }

  /** 步骤整体替换（任务步骤数量级小，重写比 diff 更简单可靠）。 */
  private writeSteps(record: TaskRecord): void {
    this.statement('DELETE FROM task_steps WHERE task_id = ?').run(record.id);
    const insert = this.statement(
      `INSERT INTO task_steps (task_id, id, position, title, details, status, verification,
          evidence, blocked_reason, started_at, completed_at)
       VALUES (:taskId, :id, :position, :title, :details, :status, :verification,
          :evidence, :blockedReason, :startedAt, :completedAt)`,
    );
    for (const step of sortSteps(record.steps)) {
      insert.run({
        taskId: record.id,
        id: step.id,
        position: step.position,
        title: step.title,
        details: step.details ?? null,
        status: step.status,
        verification: step.verification === undefined ? null : JSON.stringify(step.verification),
        evidence: step.evidence === undefined ? null : JSON.stringify(step.evidence),
        blockedReason: step.blockedReason ?? null,
        startedAt: epochOf(step.startedAt),
        completedAt: epochOf(step.completedAt),
      });
    }
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    prepared.setAllowBareNamedParameters(true);
    this.statements.set(sql, prepared);
    return prepared;
  }
}

function toRecord(
  row: Record<string, unknown>,
  stepRows: Array<Record<string, unknown>>,
): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    goal: String(row.goal),
    status: String(row.status) as TaskRecord['status'],
    origin: String(row.origin) as TaskRecord['origin'],
    ...(row.session_id === null || row.session_id === undefined
      ? {}
      : { sessionId: String(row.session_id) }),
    ...(row.cwd === null || row.cwd === undefined ? {} : { cwd: String(row.cwd) }),
    revision: Number(row.revision),
    ...(row.blocked_reason === null || row.blocked_reason === undefined
      ? {}
      : { blockedReason: String(row.blocked_reason) }),
    ...(row.conclusion === null || row.conclusion === undefined
      ? {}
      : { conclusion: String(row.conclusion) }),
    execution: parseJson<TaskExecution>(row.execution) ?? { attempt: 1 },
    createdAt: isoOf(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoOf(row.updated_at) ?? new Date(0).toISOString(),
    steps: stepRows.map(toStep),
  };
}

function toStep(row: Record<string, unknown>): TaskStep {
  return {
    id: String(row.id),
    title: String(row.title),
    status: String(row.status) as TaskStep['status'],
    position: Number(row.position),
    ...(row.details === null || row.details === undefined ? {} : { details: String(row.details) }),
    ...(parseJson<StepVerification>(row.verification) === undefined
      ? {}
      : { verification: parseJson<StepVerification>(row.verification)! }),
    ...(parseJson<StepEvidence>(row.evidence) === undefined
      ? {}
      : { evidence: parseJson<StepEvidence>(row.evidence)! }),
    ...(row.blocked_reason === null || row.blocked_reason === undefined
      ? {}
      : { blockedReason: String(row.blocked_reason) }),
    ...(isoOf(row.started_at) === undefined ? {} : { startedAt: isoOf(row.started_at)! }),
    ...(isoOf(row.completed_at) === undefined ? {} : { completedAt: isoOf(row.completed_at)! }),
  };
}

/** 内存实现：与 SQLite 语义一致（同样的过滤、排序、乐观并发判定）。 */
export class MemoryTaskRepository implements TaskRepository {
  readonly kind = 'memory' as const;
  private readonly tasks = new Map<string, TaskRecord>();

  get(id: string): TaskRecord | undefined {
    const record = this.tasks.get(id);
    return record === undefined ? undefined : clone(record);
  }

  list(query: TaskQuery = {}): TaskRecord[] {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_TASK_LIMIT, 1), MAX_TASK_LIMIT);
    return [...this.tasks.values()]
      .filter((record) => query.status === undefined || record.status === query.status)
      .filter((record) => query.sessionId === undefined || record.sessionId === query.sessionId)
      .filter((record) => query.cwd === undefined || record.cwd === query.cwd)
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          (right.id < left.id ? -1 : right.id > left.id ? 1 : 0),
      )
      .slice(0, limit)
      .map(clone);
  }

  insert(record: TaskRecord): void {
    if (this.tasks.has(record.id)) throw new Error(`Task ${record.id} already exists`);
    this.tasks.set(record.id, clone({ ...record, revision: record.revision ?? 1 }));
  }

  save(
    record: TaskRecord,
    expectedRevision: number,
    options: { keepRevision?: boolean } = {},
  ): boolean {
    const current = this.tasks.get(record.id);
    if (!current || current.revision !== expectedRevision) return false;
    this.tasks.set(
      record.id,
      clone({
        ...record,
        revision: options.keepRevision === true ? expectedRevision : expectedRevision + 1,
      }),
    );
    return true;
  }

  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  close(): void {
    this.tasks.clear();
  }
}

/** 深拷贝（避免调用方拿到内部引用后直接改状态）。 */
function clone(record: TaskRecord): TaskRecord {
  return structuredClone(record);
}

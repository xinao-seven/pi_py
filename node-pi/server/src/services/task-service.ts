/**
 * 任务服务（M2）：用例外层 + 状态聚合 + 乐观并发。
 *
 * 中文说明：路由只做参数搬运，规则都在这里。三条核心约定：
 * 1. **状态是派生的**：任务的 `status` 由步骤状态聚合而来（`deriveTaskStatus`），
 *    避免「任务说进行中、步骤全完成」这种自相矛盾。只有终态（completed / cancelled）
 *    是粘滞的——终态之后再改步骤不会把任务「撤回」到进行中。
 * 2. **写入必须带版本**：`ifRevision` 与库里的 `revision` 不一致就 409 `task_conflict`，
 *    不会发生「两个客户端互相覆盖」。
 * 3. **变更即广播**：每次成功写入都会把最新记录推给监听器（注册表把它转成 SSE
 *    `task_updated`），前端面板因此不需要轮询。
 *
 * 边界：M2 只做领域与接口，不做「执行」——`execution`（租约/心跳/在飞动作）与
 * `/resume`、`/recovery` 属于 M3。
 */

import { randomUUID } from 'node:crypto';

import { ApiError } from '../errors.js';
import {
  applyStepStatus,
  deriveTaskStatus,
  emptyExecution,
  isTerminalStatus,
  moveStep,
  newStep,
  nextStepId,
  normalizePositions,
  sortSteps,
  STEP_STATUSES,
  TASK_STATUSES,
  type StepEvidence,
  type StepStatus,
  type StepVerification,
  type TaskOrigin,
  type TaskQuery,
  type TaskRecord,
  type TaskStep,
  type TaskStatus,
} from './platform/task-model.js';
import type { TaskRepository } from './platform/task-repository.js';

/** 字段长度上限（防止把整篇文件塞进任务里）。 */
const LIMITS = {
  title: 200,
  goal: 2_000,
  stepTitle: 500,
  details: 4_000,
  reason: 1_000,
  conclusion: 4_000,
  listLimit: 500,
} as const;

export interface CreateTaskStepInput {
  id?: string;
  title: string;
  details?: string;
  verification?: StepVerification;
  position?: number;
}

export interface CreateTaskInput {
  title: string;
  goal: string;
  origin?: TaskOrigin;
  sessionId?: string;
  cwd?: string;
  steps?: CreateTaskStepInput[];
}

export interface UpdateTaskInput {
  title?: string;
  goal?: string;
  status?: TaskStatus;
  blockedReason?: string;
  conclusion?: string;
  ifRevision?: unknown;
}

export interface AddStepInput {
  title: string;
  details?: string;
  verification?: StepVerification;
  position?: number;
  ifRevision?: unknown;
}

export interface UpdateStepInput {
  title?: string;
  details?: string;
  status?: StepStatus;
  position?: number;
  evidence?: StepEvidence;
  blockedReason?: string;
  ifRevision?: unknown;
}

export interface TaskServiceOptions {
  /** 注入 id 生成器（测试用）。 */
  idFactory?: () => string;
  /** 注入时间源（测试用）。 */
  now?: () => Date;
}

/** 任务服务：路由与（后续）Plan/断点续跑都通过它操作任务。 */
export class TaskService {
  private listener: ((task: TaskRecord) => void) | undefined;
  private sessionTaskListener: ((sessionId: string, taskId: string | null) => void) | undefined;

  constructor(
    private readonly repository: TaskRepository,
    private readonly options: TaskServiceOptions = {},
  ) {}

  /** 注册「任务已变更」监听器（注册表用它发 SSE `task_updated`）。 */
  setListener(listener: (task: TaskRecord) => void): void {
    this.listener = listener;
  }

  /** 注册「任务绑定到会话」监听器（注册表用它把 task_id 带给账本）。 */
  setSessionTaskListener(listener: (sessionId: string, taskId: string | null) => void): void {
    this.sessionTaskListener = listener;
  }

  /** 新建任务（`steps` 可选：可先建任务壳，再逐步拆解）。 */
  create(input: CreateTaskInput): TaskRecord {
    const now = this.nowIso();
    const title = this.requiredText(input.title, 'title', LIMITS.title);
    const goal = this.requiredText(input.goal, 'goal', LIMITS.goal);
    const steps = this.normalizeSteps(
      (input.steps ?? []).map((step, index) =>
        newStep({
          id: this.stepIdFor(step.id, index),
          title: this.requiredText(step.title, `steps[${index}].title`, LIMITS.stepTitle),
          position: step.position ?? index,
          ...(step.details === undefined
            ? {}
            : {
                details: this.requiredText(step.details, `steps[${index}].details`, LIMITS.details),
              }),
          ...(step.verification === undefined
            ? {}
            : {
                verification: this.verificationOf(
                  step.verification,
                  `steps[${index}].verification`,
                ),
              }),
        }),
      ),
    );
    const record: TaskRecord = {
      id: this.options.idFactory?.() ?? randomUUID(),
      title,
      goal,
      status: deriveTaskStatus(steps),
      steps,
      origin: input.origin ?? 'user',
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      revision: 1,
      execution: emptyExecution(),
      createdAt: now,
      updatedAt: now,
    };
    this.repository.insert(record);
    this.notify(record);
    return record;
  }

  /** 读取任务（不存在 → 404）。 */
  get(id: string): TaskRecord {
    const record = this.repository.get(id);
    if (record === undefined) throw new ApiError(404, 'task_not_found', `Task ${id} was not found`);
    return record;
  }

  /** 列出任务（按 updatedAt 倒序）。 */
  list(
    query: { status?: unknown; sessionId?: unknown; cwd?: unknown; limit?: unknown } = {},
  ): TaskRecord[] {
    const filter: TaskQuery = {};
    if (query.status !== undefined && query.status !== '') {
      filter.status = this.oneOf(query.status, TASK_STATUSES, 'status');
    }
    if (typeof query.sessionId === 'string' && query.sessionId) filter.sessionId = query.sessionId;
    if (typeof query.cwd === 'string' && query.cwd) filter.cwd = query.cwd;
    if (query.limit !== undefined && query.limit !== '') {
      const limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listLimit) {
        throw new ApiError(
          422,
          'validation_error',
          `limit must be an integer from 1 to ${LIMITS.listLimit}`,
        );
      }
      filter.limit = limit;
    }
    return this.repository.list(filter);
  }

  /** 修改任务（标题/目标/状态/阻塞原因/结论）。 */
  update(id: string, input: UpdateTaskInput): TaskRecord {
    const current = this.get(id);
    this.assertMutable(current);
    const expected = this.requiredRevision(input.ifRevision);
    const next: TaskRecord = { ...current };
    if (input.title !== undefined)
      next.title = this.requiredText(input.title, 'title', LIMITS.title);
    if (input.goal !== undefined) next.goal = this.requiredText(input.goal, 'goal', LIMITS.goal);
    if (input.blockedReason !== undefined) {
      next.blockedReason = input.blockedReason
        ? this.requiredText(input.blockedReason, 'blockedReason', LIMITS.reason)
        : undefined;
    }
    if (input.conclusion !== undefined) {
      next.conclusion = input.conclusion
        ? this.requiredText(input.conclusion, 'conclusion', LIMITS.conclusion)
        : undefined;
    }
    if (input.status !== undefined) {
      const status = this.oneOf(input.status, TASK_STATUSES, 'status');
      // 手动设置的状态是「显式意图」：终态粘滞，非终态会在下一次步骤变更时被重新聚合。
      next.status = status;
      if (status === 'blocked' && !next.blockedReason) {
        throw new ApiError(
          422,
          'validation_error',
          'blockedReason is required when status is blocked',
        );
      }
      if (status !== 'blocked') next.blockedReason = undefined;
    }
    return this.commit(next, expected);
  }

  /** 取消任务（终态，幂等；带 ifRevision 时仍会先做并发校验）。 */
  cancel(id: string, input: { ifRevision?: unknown; reason?: unknown } = {}): TaskRecord {
    const current = this.get(id);
    const expected =
      input.ifRevision === undefined ? current.revision : this.requiredRevision(input.ifRevision);
    // 先校验版本再谈幂等：陈旧写入不能悄悄变成 no-op（与其它变更保持一致）。
    if (expected !== current.revision) {
      throw new ApiError(409, 'task_conflict', 'Task was modified by someone else', {
        expectedRevision: expected,
        currentRevision: current.revision,
      });
    }
    if (current.status === 'cancelled') return current; // 幂等：不再改版本、不再广播
    const next: TaskRecord = {
      ...current,
      status: 'cancelled',
      ...(typeof input.reason === 'string' && input.reason
        ? { blockedReason: this.requiredText(input.reason, 'reason', LIMITS.reason) }
        : {}),
    };
    return this.commit(next, current.revision);
  }

  /** 追加步骤（默认追加到末尾，也可指定 position）。 */
  addStep(taskId: string, input: AddStepInput): TaskRecord {
    const current = this.get(taskId);
    this.assertMutable(current);
    const expected = this.requiredRevision(input.ifRevision);
    const step = newStep({
      id: nextStepId(current.steps),
      title: this.requiredText(input.title, 'title', LIMITS.stepTitle),
      position: input.position ?? current.steps.length,
      ...(input.details === undefined
        ? {}
        : { details: this.requiredText(input.details, 'details', LIMITS.details) }),
      ...(input.verification === undefined
        ? {}
        : { verification: this.verificationOf(input.verification, 'verification') }),
    });
    const steps = normalizePositions(sortSteps([...current.steps, step]));
    return this.commit(this.withDerivedStatus({ ...current, steps }), expected);
  }

  /** 修改步骤（状态 / 文案 / 顺序 / 证据）。 */
  updateStep(taskId: string, stepId: string, input: UpdateStepInput): TaskRecord {
    const current = this.get(taskId);
    this.assertMutable(current);
    const expected = this.requiredRevision(input.ifRevision);
    const existing = current.steps.find((step) => step.id === stepId);
    if (existing === undefined) {
      throw new ApiError(404, 'task_step_not_found', `Step ${stepId} was not found`);
    }
    const now = this.nowIso();
    let updated: TaskStep = { ...existing };
    if (input.title !== undefined) {
      updated.title = this.requiredText(input.title, 'title', LIMITS.stepTitle);
    }
    if (input.details !== undefined) {
      updated.details = input.details
        ? this.requiredText(input.details, 'details', LIMITS.details)
        : undefined;
    }
    if (input.blockedReason !== undefined) {
      updated.blockedReason = input.blockedReason
        ? this.requiredText(input.blockedReason, 'blockedReason', LIMITS.reason)
        : undefined;
    }
    if (input.evidence !== undefined) {
      updated.evidence = this.evidenceOf(input.evidence, 'evidence');
    }
    if (input.status !== undefined) {
      const status = this.oneOf(input.status, STEP_STATUSES, 'status');
      if (status === 'blocked' && !updated.blockedReason) {
        throw new ApiError(
          422,
          'validation_error',
          'blockedReason is required when a step is blocked',
        );
      }
      updated = applyStepStatus(updated, status, now);
    }
    const steps =
      input.position === undefined
        ? normalizePositions(
            sortSteps(current.steps.map((step) => (step.id === stepId ? updated : step))),
          )
        : moveStep(
            current.steps.map((step) => (step.id === stepId ? updated : step)),
            stepId,
            input.position,
          );
    return this.commit(this.withDerivedStatus({ ...current, steps }), expected);
  }

  /** 删除步骤；已完成的步骤需要显式 `force`。 */
  removeStep(
    taskId: string,
    stepId: string,
    input: { ifRevision?: unknown; force?: unknown },
  ): TaskRecord {
    const current = this.get(taskId);
    this.assertMutable(current);
    const expected = this.requiredRevision(input.ifRevision);
    const existing = current.steps.find((step) => step.id === stepId);
    if (existing === undefined) {
      throw new ApiError(404, 'task_step_not_found', `Step ${stepId} was not found`);
    }
    if (existing.status === 'completed' && input.force !== true) {
      throw new ApiError(409, 'step_completed', 'Deleting a completed step requires force=true');
    }
    const steps = normalizePositions(sortSteps(current.steps.filter((step) => step.id !== stepId)));
    return this.commit(this.withDerivedStatus({ ...current, steps }), expected);
  }

  /**
   * 由步骤状态重新聚合任务状态。
   * 中文说明：终态（completed / cancelled）粘滞——终态之后再改步骤不会把任务撤回；
   * 阻塞时若任务层没有原因，则从第一个阻塞步骤复制过来，免得面板上显示「阻塞但没原因」。
   */
  refreshStatus(task: TaskRecord): TaskRecord {
    if (isTerminalStatus(task.status)) return task;
    const status = deriveTaskStatus(task.steps);
    const blockedReason =
      status === 'blocked'
        ? (task.blockedReason ??
          task.steps.find((step) => step.status === 'blocked')?.blockedReason)
        : undefined;
    return {
      ...task,
      status,
      ...(blockedReason === undefined ? { blockedReason: undefined } : { blockedReason }),
    };
  }

  /** 把任务绑定到会话（会话执行该任务时，账本会把 task_id 写进 run）。 */
  attachToSession(taskId: string, sessionId: string | null): TaskRecord {
    const current = this.get(taskId);
    const expected = current.revision;
    return this.commit({ ...current, sessionId: sessionId ?? undefined }, expected);
  }

  /** 释放资源（服务关闭时调用）。 */
  dispose(): void {
    this.listener = undefined;
    this.sessionTaskListener = undefined;
  }

  // ---- 内部 ----

  /** 写入 + 广播：乐观并发失败统一转 409。 */
  private commit(next: TaskRecord, expectedRevision: number): TaskRecord {
    const stored: TaskRecord = { ...next, updatedAt: this.nowIso() };
    const applied = this.repository.save(stored, expectedRevision);
    if (!applied) {
      const current = this.repository.get(stored.id);
      throw new ApiError(409, 'task_conflict', 'Task was modified by someone else', {
        expectedRevision,
        currentRevision: current?.revision ?? null,
      });
    }
    const saved = this.repository.get(stored.id) ?? stored;
    this.notify(saved);
    return saved;
  }

  private withDerivedStatus(task: TaskRecord): TaskRecord {
    return this.refreshStatus(task);
  }

  private notify(task: TaskRecord): void {
    try {
      this.listener?.(task);
      if (task.sessionId) this.sessionTaskListener?.(task.sessionId, task.id);
    } catch {
      // 广播失败不能影响写入结果（观测/推送是增量能力）。
    }
  }

  private assertMutable(task: TaskRecord): void {
    if (task.status === 'cancelled') {
      throw new ApiError(409, 'task_cancelled', 'A cancelled task can no longer be modified');
    }
  }

  private requiredRevision(value: unknown): number {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new ApiError(422, 'validation_error', 'ifRevision must be a positive integer');
    }
    return value as number;
  }

  private requiredText(value: unknown, field: string, max: number): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ApiError(422, 'validation_error', `${field} must be a non-empty string`);
    }
    const text = value.trim();
    if (text.length > max) {
      throw new ApiError(422, 'validation_error', `${field} must be at most ${max} characters`);
    }
    return text;
  }

  private oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      throw new ApiError(422, 'validation_error', `${field} must be one of: ${allowed.join(', ')}`);
    }
    return value as T;
  }

  private stepIdFor(id: string | undefined, index: number): string {
    if (id !== undefined) {
      if (!/^s\d+$/.test(id)) {
        throw new ApiError(422, 'validation_error', `steps[${index}].id must look like "s1"`);
      }
      return id;
    }
    return `s${index + 1}`;
  }

  private normalizeSteps(steps: TaskStep[]): TaskStep[] {
    const ids = new Set<string>();
    for (const step of steps) {
      if (ids.has(step.id)) {
        throw new ApiError(422, 'validation_error', `Duplicate step id: ${step.id}`);
      }
      ids.add(step.id);
    }
    return normalizePositions(sortSteps(steps));
  }

  private verificationOf(value: unknown, field: string): StepVerification {
    if (!value || typeof value !== 'object') {
      throw new ApiError(422, 'validation_error', `${field} must be an object`);
    }
    const input = value as Record<string, unknown>;
    const kind = this.oneOf(input.kind, ['command', 'file', 'manual'] as const, `${field}.kind`);
    const result: StepVerification = { kind };
    if (input.command !== undefined) {
      result.command = this.requiredText(input.command, `${field}.command`, LIMITS.details);
    }
    if (input.expectExitCode !== undefined) {
      if (!Number.isInteger(input.expectExitCode)) {
        throw new ApiError(422, 'validation_error', `${field}.expectExitCode must be an integer`);
      }
      result.expectExitCode = input.expectExitCode as number;
    }
    if (input.path !== undefined) {
      result.path = this.requiredText(input.path, `${field}.path`, LIMITS.details);
    }
    if (kind === 'command' && !result.command) {
      throw new ApiError(422, 'validation_error', `${field}.command is required for kind=command`);
    }
    if (kind === 'file' && !result.path) {
      throw new ApiError(422, 'validation_error', `${field}.path is required for kind=file`);
    }
    return result;
  }

  private evidenceOf(value: unknown, field: string): StepEvidence {
    if (!value || typeof value !== 'object') {
      throw new ApiError(422, 'validation_error', `${field} must be an object`);
    }
    const input = value as Record<string, unknown>;
    const evidence: StepEvidence = { toolCallIds: [], filesTouched: [] };
    if (input.summary !== undefined) {
      evidence.summary = this.requiredText(input.summary, `${field}.summary`, LIMITS.details);
    }
    evidence.toolCallIds = this.stringList(input.toolCallIds, `${field}.toolCallIds`);
    evidence.filesTouched = this.stringList(input.filesTouched, `${field}.filesTouched`);
    if (input.lastError !== undefined) {
      evidence.lastError = this.requiredText(input.lastError, `${field}.lastError`, LIMITS.details);
    }
    if (input.commands !== undefined) {
      if (!Array.isArray(input.commands)) {
        throw new ApiError(422, 'validation_error', `${field}.commands must be an array`);
      }
      evidence.commands = input.commands.map((item, index) => {
        if (!item || typeof item !== 'object') {
          throw new ApiError(
            422,
            'validation_error',
            `${field}.commands[${index}] must be an object`,
          );
        }
        const command = item as Record<string, unknown>;
        const exitCode = command.exitCode;
        if (exitCode !== null && exitCode !== undefined && !Number.isInteger(exitCode)) {
          throw new ApiError(
            422,
            'validation_error',
            `${field}.commands[${index}].exitCode must be an integer or null`,
          );
        }
        return {
          command: this.requiredText(
            command.command,
            `${field}.commands[${index}].command`,
            LIMITS.details,
          ),
          exitCode: (exitCode ?? null) as number | null,
        };
      });
    }
    return evidence;
  }

  private stringList(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new ApiError(422, 'validation_error', `${field} must be an array of strings`);
    }
    return value as string[];
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

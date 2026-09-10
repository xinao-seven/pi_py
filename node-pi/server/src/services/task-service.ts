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
import { DEFAULT_LEASE_TTL_MS, leaseUntil, leaseView, type LeaseView } from './task-lease.js';
import {
  applyStepStatus,
  currentStep,
  deriveTaskStatus,
  emptyExecution,
  isTerminalStatus,
  moveStep,
  newStep,
  nextStepId,
  normalizePositions,
  sortSteps,
  STEP_STATUSES,
  STORED_PLAN_STATUSES,
  TASK_STATUSES,
  type StepEvidence,
  type StepStatus,
  type StepVerification,
  type StoredPlanStatus,
  type TaskOrigin,
  type TaskPlanState,
  type TaskQuery,
  type TaskRecord,
  type TaskStep,
  type TaskStatus,
  type TaskExecution,
} from './platform/task-model.js';
import type { TaskRepository } from './platform/task-repository.js';

/** 标题归一化（用于 update_plan 按标题匹配保留进度）：折叠空白、忽略大小写。 */
function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

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

/** 新建计划（M4：计划就是 `origin='plan'` 的任务）。 */
export interface CreatePlanInput {
  title: string;
  goal: string;
  sessionId?: string;
  cwd?: string;
}

/** 计划步骤的写入形态（`submit_plan` / `update_plan` 用）。 */
export interface PlanStepInput {
  title: string;
  details?: string;
  verification?: StepVerification;
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
   * 中文说明：**只有 `cancelled` 是冻结的**——它是显式的用户意图，不能被步骤变更覆盖。
   * `completed` 则与其他状态一样由步骤派生：删掉未完成的步骤就可能回到 pending/in_progress。
   * 这样做的好处是「状态只有一个真相源（步骤）」，不会出现「任务说已完成、步骤还挂着」
   * 或「删了步骤但状态回不去」这种隐藏状态。
   * 阻塞时若任务层没有原因，就从第一个阻塞步骤复制过来，免得面板上显示「阻塞但没原因」。
   */
  refreshStatus(task: TaskRecord): TaskRecord {
    if (task.status === 'cancelled') return task;
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

  // ---- M3：执行租约与在飞动作 ----

  /**
   * 取得执行租约；已被其它活跃 owner 持有时 409 `task_leased`（任务只读）。
   * `attempt` 不传则保持原值（首次执行是 1，resume 时由调用方 +1）。
   */
  acquireLease(
    taskId: string,
    owner: string,
    options: { ttlMs?: number; attempt?: number } = {},
  ): TaskRecord {
    const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    return this.mutate(taskId, (task) => {
      const view = leaseView(task.execution, owner, this.nowMs());
      this.assertLeaseFree(view, task.id);
      return {
        ...task,
        execution: {
          ...task.execution,
          attempt: options.attempt ?? task.execution.attempt,
          lease: leaseUntil(owner, this.nowMs(), ttlMs),
          lastHeartbeatAt: this.nowIso(),
        },
      };
    });
  }

  /** 续租（心跳）；租约已归属别人则 409。 */
  renewLease(taskId: string, owner: string, ttlMs = DEFAULT_LEASE_TTL_MS): TaskRecord {
    return this.mutate(taskId, (task) => {
      const view = leaseView(task.execution, owner, this.nowMs());
      this.assertLeaseFree(view, task.id);
      return {
        ...task,
        execution: {
          ...task.execution,
          lease: leaseUntil(owner, this.nowMs(), ttlMs),
          lastHeartbeatAt: this.nowIso(),
        },
      };
    });
  }

  /** 释放租约（幂等）；不是自己持有就不动。 */
  releaseLease(taskId: string, owner: string): TaskRecord {
    return this.mutate(taskId, (task) => {
      const lease = task.execution.lease;
      if (lease !== undefined && lease.owner !== owner) return task; // 别人的租约不碰
      const execution: TaskExecution = { ...task.execution };
      delete execution.lease;
      return { ...task, execution };
    });
  }

  /**
   * 记录/清除在飞动作（副作用判定的数据源，见 task-recovery.ts）。
   * 中文说明：带副作用的动作会同时留在 `lastSideEffect` 里（见 task-model.ts 的说明），
   * 直到该步骤的本次尝试结束（步骤被重置回 pending）才会自然失效。
   * 终态任务直接忽略：执行器不应该再去碰已完成/已取消的任务。
   */
  setInFlight(taskId: string, inFlight: NonNullable<TaskExecution['inFlight']> | null): TaskRecord {
    return this.mutate(taskId, (task) => {
      if (isTerminalStatus(task.status)) return task;
      const execution: TaskExecution = { ...task.execution, lastHeartbeatAt: this.nowIso() };
      if (inFlight === null) {
        delete execution.inFlight;
        return { ...task, execution };
      }
      execution.inFlight = inFlight;
      if (inFlight.sideEffect !== 'none') {
        execution.lastSideEffect = {
          ...(inFlight.stepId === undefined ? {} : { stepId: inFlight.stepId }),
          toolName: inFlight.toolName ?? 'unknown',
          sideEffect: inFlight.sideEffect,
          at: inFlight.startedAt,
        };
      }
      return { ...task, execution };
    });
  }

  /** 把当前步骤重置为 pending（`retry_step` 用）：同时清掉它的开始时间与阻塞原因。 */
  resetCurrentStep(taskId: string): TaskRecord {
    return this.mutate(taskId, (task) => {
      const step = currentStep(task.steps);
      if (step === undefined) return task;
      const steps = task.steps.map((item): TaskStep => {
        if (item.id !== step.id) return item;
        const next: TaskStep = { ...item, status: 'pending' };
        delete next.startedAt;
        delete next.completedAt;
        delete next.blockedReason;
        return next;
      });
      return this.withDerivedStatus({ ...task, steps });
    });
  }

  /**
   * 用「验证通过」的方式完成步骤（恢复时补记）：写入证据并把状态推到 completed。
   * 中文说明：只用于恢复路径——产物已在（或人工已确认），不应该重跑该步骤。
   */
  completeStepWithEvidence(taskId: string, stepId: string, evidence: StepEvidence): TaskRecord {
    return this.mutate(taskId, (task) => {
      const now = this.nowIso();
      const steps = task.steps.map((item) =>
        item.id === stepId ? { ...applyStepStatus(item, 'completed', now), evidence } : item,
      );
      return this.withDerivedStatus({ ...task, steps });
    });
  }

  /**
   * 把任务标为「被中断」（不可自动继续时用）：状态 blocked + 说明 + 清在飞 + 释放租约。
   * 中文说明：这是「宁可不跑也不能重复副作用」的落地点——无法确认产物状态时停在这里，
   * 由人来判断，而不是自动重试。
   */
  markInterrupted(taskId: string, reason: string, owner?: string): TaskRecord {
    return this.mutate(taskId, (task) => {
      const execution: TaskExecution = { ...task.execution };
      delete execution.inFlight;
      if (owner === undefined || execution.lease?.owner === owner) delete execution.lease;
      return {
        ...task,
        status: 'blocked',
        blockedReason: this.requiredText(reason, 'reason', LIMITS.reason),
        execution,
      };
    });
  }

  /** 释放资源（服务关闭时调用）。 */
  dispose(): void {
    this.listener = undefined;
    this.sessionTaskListener = undefined;
  }

  // ---- M4：计划（Plan 是 origin='plan' 的任务）----

  /**
   * 新建计划：立刻落一个空步骤的任务壳，状态 `drafting`。
   *
   * 中文说明：为什么一进入规划就建任务，而不是等 `submit_plan` 再建——
   * 「Agent 正在调研」这个阶段同样需要被持久化和被面板看到；若只在提交计划时才落库，
   * 崩溃/刷新后连「刚才在规划什么」都找不到，等于把 P8 的坑换个地方挖。空步骤任务
   * 由 `deriveTaskStatus` 聚合为 `pending`，不会与「空闲」混淆（有空步骤列表就算未完成）。
   */
  createPlan(input: CreatePlanInput): TaskRecord {
    const now = this.nowIso();
    const record: TaskRecord = {
      id: this.options.idFactory?.() ?? randomUUID(),
      title: this.requiredText(input.title, 'title', LIMITS.title),
      goal: this.requiredText(input.goal, 'goal', LIMITS.goal),
      status: 'pending',
      steps: [],
      origin: 'plan',
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      revision: 1,
      execution: { attempt: 1, plan: { status: 'drafting', draftingSince: now } },
      createdAt: now,
      updatedAt: now,
    };
    this.repository.insert(record);
    this.notify(record);
    return record;
  }

  /**
   * 更新计划的运行时状态（drafting / proposed / executing / paused）。
   * `question: null` 显式清空澄清问题（不传则保持原值）。
   */
  setPlanState(
    taskId: string,
    patch: {
      status?: StoredPlanStatus;
      question?: string | null;
      questionOptions?: string[] | null;
    },
  ): TaskRecord {
    const status =
      patch.status === undefined
        ? undefined
        : this.oneOf(patch.status, STORED_PLAN_STATUSES, 'plan.status');
    return this.mutate(taskId, (task) => {
      const current: TaskPlanState = task.execution.plan ?? { status: 'drafting' };
      const next: TaskPlanState = { ...current, updatedAt: this.nowIso() };
      if (status !== undefined) next.status = status;
      if (patch.question === null) {
        delete next.question;
        delete next.questionOptions;
      } else if (patch.question !== undefined) {
        next.question = this.requiredText(patch.question, 'question', LIMITS.reason);
        if (patch.questionOptions === null) delete next.questionOptions;
        else if (patch.questionOptions !== undefined) {
          next.questionOptions = this.stringList(patch.questionOptions, 'questionOptions');
        }
      }
      return { ...task, execution: { ...task.execution, plan: next } };
    });
  }

  /**
   * 整体替换计划步骤（`submit_plan` / `update_plan`）。
   *
   * 中文说明：**按标题匹配保留已有进度**——`update_plan` 的常见场景是「执行到一半发现后面
   * 几步要改」，如果无脑重建步骤，已完成步骤的 status/evidence 会被清空（等于忘掉刚做完的工作）。
   * 因此规则是：标题（忽略首尾与内部多余空白）相同的步骤沿用原 id、状态与证据；
   * 其余按新步骤创建，id 取现有最大编号 +1（不复用已删编号）。步骤顺序以传入顺序为准。
   */
  replacePlanSteps(taskId: string, steps: readonly PlanStepInput[]): TaskRecord {
    if (steps.length === 0)
      throw new ApiError(422, 'validation_error', 'A plan needs at least one step');
    const normalized = steps.map((step, index) => ({
      title: this.requiredText(step.title, `steps[${index}].title`, LIMITS.stepTitle),
      ...(step.details === undefined
        ? {}
        : { details: this.requiredText(step.details, `steps[${index}].details`, LIMITS.details) }),
      ...(step.verification === undefined
        ? {}
        : { verification: this.verificationOf(step.verification, `steps[${index}].verification`) }),
    }));
    const seen = new Set<string>();
    for (const [index, step] of normalized.entries()) {
      const key = normalizeTitle(step.title);
      if (seen.has(key))
        throw new ApiError(
          422,
          'validation_error',
          `Duplicate plan step title at index ${index}: ${step.title}`,
        );
      seen.add(key);
    }
    return this.mutate(taskId, (task) => {
      this.assertMutable(task);
      const reused = new Set<string>();
      let steps = task.steps;
      const next = normalized.map((input, position): TaskStep => {
        const key = normalizeTitle(input.title);
        const existing = task.steps.find(
          (step) => !reused.has(step.id) && normalizeTitle(step.title) === key,
        );
        if (existing !== undefined) {
          reused.add(existing.id);
          return {
            ...existing,
            title: input.title,
            position,
            ...(input.details === undefined ? {} : { details: input.details }),
            ...(input.verification === undefined ? {} : { verification: input.verification }),
          };
        }
        const step = newStep({
          id: nextStepId(steps),
          title: input.title,
          position,
          ...(input.details === undefined ? {} : { details: input.details }),
          ...(input.verification === undefined ? {} : { verification: input.verification }),
        });
        steps = [...steps, step]; // 让 nextStepId 看到刚占用的编号
        return step;
      });
      return this.withDerivedStatus({ ...task, steps: normalizePositions(next) });
    });
  }

  /** 放弃计划：取消任务（记录保留，视图由任务状态推导为 abandoned）。 */
  abandonPlan(taskId: string, reason?: string): TaskRecord {
    const current = this.get(taskId);
    return this.cancel(taskId, {
      ifRevision: current.revision,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  /** 会话当前活跃计划：优先未完成的，其次最近更新的（用于会话打开时重新接管）。 */
  activePlanForSession(sessionId: string): TaskRecord | undefined {
    const plans = this.repository
      .list({ sessionId, limit: LIMITS.listLimit })
      .filter((task) => task.origin === 'plan');
    return (
      plans.find((task) => !isTerminalStatus(task.status)) ??
      plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    );
  }

  // ---- 内部 ----

  /**
   * 内部写入（租约/在飞动作）：读→改→写，版本冲突自动重试。
   * 中文说明：这些写入来自执行器与事件钩子，不是用户操作；即便如此也会**广播**——
   * 否则面板手里的 `revision` 会静默落后，用户下一次点击就会莫名其妙 409。
   */
  private mutate(taskId: string, change: (task: TaskRecord) => TaskRecord): TaskRecord {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = this.get(taskId);
      const stored: TaskRecord = { ...change(current), updatedAt: this.nowIso() };
      if (this.repository.save(stored, current.revision)) {
        const saved = this.repository.get(taskId) ?? stored;
        this.notify(saved);
        return saved;
      }
    }
    throw new ApiError(409, 'task_conflict', 'Task was modified concurrently');
  }

  private assertLeaseFree(view: LeaseView, taskId: string): void {
    if (!view.heldByOther) return;
    throw new ApiError(409, 'task_leased', `Task ${taskId} is being executed by ${view.owner}`, {
      owner: view.owner,
      expiresAt: view.expiresAt,
    });
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

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

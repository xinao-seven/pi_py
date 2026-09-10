/**
 * 任务领域的模型与纯函数（M2）。
 *
 * 中文说明：任务是「一等公民」——它既是 Plan 的载体（M4 会把计划的步骤映射成任务的步骤），
 * 也是断点续跑的控制面（M3 的租约/心跳/在飞动作都挂在 `execution` 上）。因此这里的字段
 * 比现有 PlanTodo 多：`verification`（完成声明）、`evidence`（完成证据）、`revision`（乐观并发）。
 *
 * 时间字段一律用 ISO 字符串（与规划 §4.2.1 的 TS 模型一致）；SQLite 里存 epoch 毫秒，
 * 转换只发生在仓储的读写映射处。
 */

export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** 任务来源：手工创建，或由 Plan 生成（M4）。 */
export type TaskOrigin = 'user' | 'plan';

/**
 * 步骤完成的验证声明。
 * 中文说明：M2 只负责**存下来并回显**；真正的校验（跑命令/查产物）由 M4 的完成工具做，
 * 这样「模型自报完成」在系统层面是可验证的，而不是只信模型的话。
 */
export interface StepVerification {
  kind: 'command' | 'file' | 'manual';
  command?: string;
  expectExitCode?: number;
  path?: string;
}

/** 步骤完成证据。 */
export interface StepEvidence {
  summary?: string;
  toolCallIds: string[];
  filesTouched: string[];
  commands?: Array<{ command: string; exitCode: number | null }>;
  lastError?: string;
}

export interface TaskStep {
  /** 稳定 id（'s1'）：Plan 步骤沿用，删除后不复用。 */
  id: string;
  title: string;
  details?: string;
  status: StepStatus;
  /** 顺序（0 起，连续整数）；重排时整体重写。 */
  position: number;
  verification?: StepVerification;
  evidence?: StepEvidence;
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
}

/** 执行租约：谁在跑、跑到什么时候（M3）。 */
export interface TaskLease {
  owner: string;
  expiresAt: string;
}

/** 执行态（M3 断点续跑用）。 */
export interface TaskExecution {
  attempt: number;
  lastHeartbeatAt?: string;
  lease?: TaskLease;
  inFlight?: {
    stepId?: string;
    kind: 'turn' | 'tool';
    toolCallId?: string;
    startedAt: string;
    /** 崩溃时无法判定副作用是否已落地 → 恢复时必须人工确认 */
    sideEffect: 'none' | 'write' | 'unknown';
    /** 在飞动作的工具名（面板/恢复清单用）。 */
    toolName?: string;
  };
  /**
   * 最近一次有副作用的动作（比规划更保守的一处）：
   *
   * 中文说明：inFlight 在 `tool_execution_end` 就清空了，但那时**步骤本身还没被标记完成**——
   * 如果在下一个工具调用之前进程被杀，只看 inFlight 会得到「两步之间→可自动继续」，
   * 而实际上刚才那个写操作已经落地、重跑会重复副作用。所以这里多留一个标记：
   * 只要它属于**当前步骤的本次尝试**（`at >= step.startedAt`），恢复时就仍要求人工确认。
   */
  lastSideEffect?: {
    stepId?: string;
    toolName: string;
    sideEffect: 'write' | 'unknown';
    at: string;
  };
}

export interface TaskRecord {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  steps: TaskStep[];
  origin: TaskOrigin;
  sessionId?: string;
  cwd?: string;
  /** 乐观并发版本号：每次写入 +1，写入必须带 `ifRevision`。 */
  revision: number;
  blockedReason?: string;
  conclusion?: string;
  execution: TaskExecution;
  createdAt: string;
  updatedAt: string;
}

/** 列表过滤条件。 */
export interface TaskQuery {
  status?: TaskStatus;
  sessionId?: string;
  cwd?: string;
  limit?: number;
}

/** 终态：completed（由步骤聚合）与 cancelled（显式冻结）都不再需要推进。 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/** 冻结状态：只能由 cancel() 设置，不能被步骤变更覆盖。 */
export function isFrozenStatus(status: TaskStatus): boolean {
  return status === 'cancelled';
}

/**
 * 由步骤状态聚合出任务状态（唯一真相源，避免出现两套互相矛盾的状态）。
 *
 * 中文说明：优先级从高到低——全完成 → completed；任一 blocked → blocked（需要人介入，
 * 比 in_progress 更该被看到）；**已有步骤被处理过**（completed / skipped / in_progress）
 * → in_progress；全部 pending → pending。空步骤列表视为 pending（新建任务尚未拆解）。
 *
 * 「已开工」为什么不能只看 in_progress：模型通常是一步完成、下一条还没开始时才更新状态，
 * 若只认 in_progress，「2 步里做完 1 步」的任务会被显示成 pending（尚未开始），与实际相反。
 *
 * 注意：`cancelled` 不参与聚合——它是显式的终态，只能由 cancel() 设置，
 * 否则「取消」会在下一次步骤变更时被自动覆盖。
 */
export function deriveTaskStatus(steps: readonly TaskStep[]): Exclude<TaskStatus, 'cancelled'> {
  if (steps.length === 0) return 'pending';
  if (steps.every((step) => step.status === 'completed' || step.status === 'skipped')) {
    return 'completed';
  }
  if (steps.some((step) => step.status === 'blocked')) return 'blocked';
  if (steps.some((step) => step.status !== 'pending')) return 'in_progress';
  return 'pending';
}

/** 下一个稳定步骤 id：'s{n}'，取现有最大编号 +1（不复用被删除的编号）。 */
export function nextStepId(steps: readonly TaskStep[]): string {
  let max = 0;
  for (const step of steps) {
    const matched = /^s(\d+)$/.exec(step.id);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return `s${max + 1}`;
}

/** 把步骤的 position 归一化成 0..n-1 的连续整数（保持传入顺序）。 */
export function normalizePositions(steps: readonly TaskStep[]): TaskStep[] {
  return steps.map((step, index) =>
    step.position === index ? step : { ...step, position: index },
  );
}

/** 按 position 排序（相同 position 时按 id 稳定）。 */
export function sortSteps(steps: readonly TaskStep[]): TaskStep[] {
  return [...steps].sort(
    (left, right) => left.position - right.position || (left.id < right.id ? -1 : 1),
  );
}

/** 把某个步骤移动到目标下标，并归一化 position。 */
export function moveStep(steps: readonly TaskStep[], stepId: string, position: number): TaskStep[] {
  const ordered = sortSteps(steps);
  const index = ordered.findIndex((step) => step.id === stepId);
  if (index < 0) return ordered;
  const [moved] = ordered.splice(index, 1);
  ordered.splice(Math.max(0, Math.min(ordered.length, position)), 0, moved);
  return normalizePositions(ordered);
}

/**
 * 应用步骤状态变更，并维护 startedAt / completedAt。
 * 中文说明：回到 pending/in_progress 时清掉 completedAt（重试语义），
 * 进入 completed 时补 completedAt 与清空 blockedReason——这些细节由纯函数统一处理，
 * 避免服务层与仓储层各写一份。
 */
export function applyStepStatus(step: TaskStep, status: StepStatus, now: string): TaskStep {
  const next: TaskStep = { ...step, status };
  if (status === 'in_progress') {
    next.startedAt = step.startedAt ?? now;
    delete next.completedAt;
  } else if (status === 'completed') {
    next.startedAt = step.startedAt ?? now;
    next.completedAt = now;
    delete next.blockedReason;
  } else if (status === 'pending') {
    delete next.startedAt;
    delete next.completedAt;
  } else if (status === 'blocked') {
    next.startedAt = step.startedAt ?? now;
    delete next.completedAt;
  }
  return next;
}

/** 新建步骤的默认值。 */
export function newStep(input: {
  id: string;
  title: string;
  details?: string;
  position: number;
  verification?: StepVerification;
}): TaskStep {
  return {
    id: input.id,
    title: input.title,
    status: 'pending',
    position: input.position,
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
  };
}

/** 空执行态（新建任务时）。 */
export function emptyExecution(): TaskExecution {
  return { attempt: 1 };
}

/** 当前步骤：优先进行中的，其次第一个待开始的。 */
export function currentStep(steps: readonly TaskStep[]): TaskStep | undefined {
  const ordered = sortSteps(steps);
  return (
    ordered.find((step) => step.status === 'in_progress') ??
    ordered.find((step) => step.status === 'pending')
  );
}

/** 租约是否仍然有效（时间到了就算过期，哪怕持有进程还活着）。 */
export function isLeaseActive(lease: TaskLease | undefined, nowMs: number): lease is TaskLease {
  if (lease === undefined) return false;
  const expires = Date.parse(lease.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

/**
 * 任务是否处于「疑似中断」状态（M3 恢复清单的入口条件）。
 *
 * 中文说明：判定刻意只看「任务在推进 且 租约不活跃」——不区分是崩溃、强杀还是优雅退出，
 * 因为服务重启后这三者在库里长得一模一样：任务还是 in_progress，但没人在跑它。
 * 已 blocked 的任务不进恢复清单：它已经在面板上等人处理了，不是「静默中断」。
 */
export function isInterrupted(task: TaskRecord, nowMs: number): boolean {
  if (task.status !== 'in_progress') return false;
  return !isLeaseActive(task.execution.lease, nowMs);
}

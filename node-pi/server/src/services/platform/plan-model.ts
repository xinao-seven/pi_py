/**
 * Plan 领域模型（M4）：Plan 是 Task 的**受控视图**，不是第二套模型。
 *
 * 中文说明：这个文件只放纯函数与类型，且**不持有任何状态**——
 * 计划的状态真相源是任务（`tasks` 表 + `execution.plan`），
 * `PlanView` 是每次读取时现算出来的只读投影（`toPlanView`）。
 * 这样做的直接好处：
 *
 * - 服务重启后不需要任何「恢复计划」的额外逻辑：任务还在，视图就还在（修掉 P8）；
 * - 不再往会话 JSONL 里追加状态快照（修掉 P5 的膨胀），JSONL 只留一条指针；
 * - `planId` 与 `taskId` 1:1，因此直接用任务 id 作为 planId，不维护第二套 id 映射。
 */

import { sortSteps, type TaskPlanState, type TaskRecord, type TaskStep } from './task-model.js';

export const PLAN_STATUSES = [
  'drafting', // Agent 正在调研/撰写计划
  'proposed', // 已提交计划，等待用户确认
  'executing',
  'paused', // 用户暂停，或被阻塞/崩溃中断
  'completed',
  'abandoned',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** 计划步骤视图：字段与 `TaskStep` 一一对应（前端不再需要第二套类型）。 */
export interface PlanStepView {
  id: string;
  title: string;
  details?: string;
  status: TaskStep['status'];
  verification?: TaskStep['verification'];
  evidence?: TaskStep['evidence'];
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PlanView {
  /** 稳定 id，贯穿全生命周期；与 `taskId` 相同（1:1，见文件头说明）。 */
  planId: string;
  taskId: string;
  sessionId: string;
  status: PlanStatus;
  /** 任务的乐观并发版本号：`update_plan` 与前端编辑都要带它。 */
  revision: number;
  title: string;
  goal: string;
  steps: PlanStepView[];
  /** 需要用户动手时为 true：待确认、已暂停/阻塞、有澄清问题。 */
  awaitingUserAction: boolean;
  /** 待用户回答的澄清问题（`ask_user`）。 */
  question?: string;
  questionOptions?: string[];
  draftingSince?: string;
  updatedAt: string;
}

/** 计划是否「还活着」（未完成、未放弃）。 */
export function isActivePlanStatus(status: PlanStatus): boolean {
  return status !== 'completed' && status !== 'abandoned';
}

/**
 * 由任务推导计划的当前状态。
 *
 * 中文说明：优先级从高到低——
 * 1. 任务 `cancelled` → `abandoned`（放弃计划＝取消任务，记录保留）；
 * 2. 任务 `completed` → `completed`（步骤全完成，由任务状态聚合保证）；
 * 3. 显式 `paused` → `paused`（用户主动暂停）；
 * 4. 任务 `blocked` → `paused`（有步骤阻塞，在等人处理——语义与「暂停」一致，不必再存一份）；
 * 5. 其余取落库的意图（drafting / proposed / executing），缺省视为 drafting。
 *
 * 刻意**不**推导「executing 但步骤全 pending」之类的一致性修正：那属于服务层校验的职责，
 * 视图层擅自改写状态只会让两边更难对齐。
 */
export function derivePlanStatus(task: TaskRecord): PlanStatus {
  if (task.status === 'cancelled') return 'abandoned';
  if (task.status === 'completed') return 'completed';
  const stored = task.execution.plan?.status;
  if (stored === 'paused') return 'paused';
  if (task.status === 'blocked') return 'paused';
  return stored ?? 'drafting';
}

/** 该计划是否需要用户动手（确认 / 解阻塞 / 回答澄清）。 */
export function planAwaitingUserAction(status: PlanStatus, plan?: TaskPlanState): boolean {
  if (plan?.question !== undefined) return true;
  return status === 'proposed' || status === 'paused';
}

/** 计划视图（只读投影；`query` 传入时按它过滤/排序步骤）。 */
export function toPlanView(task: TaskRecord): PlanView {
  const plan = task.execution.plan;
  const status = derivePlanStatus(task);
  const steps: PlanStepView[] = sortSteps(task.steps).map((step) => ({
    id: step.id,
    title: step.title,
    ...(step.details === undefined ? {} : { details: step.details }),
    status: step.status,
    ...(step.verification === undefined ? {} : { verification: step.verification }),
    ...(step.evidence === undefined ? {} : { evidence: step.evidence }),
    ...(step.blockedReason === undefined ? {} : { blockedReason: step.blockedReason }),
    ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
    ...(step.completedAt === undefined ? {} : { completedAt: step.completedAt }),
  }));
  return {
    planId: task.id,
    taskId: task.id,
    sessionId: task.sessionId ?? '',
    status,
    revision: task.revision,
    title: task.title,
    goal: task.goal,
    steps,
    awaitingUserAction: planAwaitingUserAction(status, plan),
    ...(plan?.question === undefined ? {} : { question: plan.question }),
    ...(plan?.questionOptions === undefined ? {} : { questionOptions: plan.questionOptions }),
    ...(plan?.draftingSince === undefined ? {} : { draftingSince: plan.draftingSince }),
    updatedAt: task.updatedAt,
  };
}

/** 空计划视图（会话没有计划时，前端拿它与「无计划」区分：`planId` 为空串）。 */
export function emptyPlanView(sessionId: string): PlanView {
  return {
    planId: '',
    taskId: '',
    sessionId,
    status: 'abandoned',
    revision: 0,
    title: '',
    goal: '',
    steps: [],
    awaitingUserAction: false,
    updatedAt: new Date(0).toISOString(),
  };
}

/** 从一段用户消息里取计划标题：第一行非空内容，超长截断。 */
export function planTitleFromMessage(message: string, max = 80): string {
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>\-*\s]+/, '').trim())
    .find((line) => line.length > 0);
  const title = firstLine ?? '未命名计划';
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

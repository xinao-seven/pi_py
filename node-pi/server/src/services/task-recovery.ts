/**
 * 任务恢复清单与副作用判定（M3）。
 *
 * 中文说明：断点续跑最关键、也最容易被忽略的一点是——**崩溃时那个动作到底落地了没有**。
 * 猜错的代价是不对称的：把「已落地」当成「没落地」→ 重复副作用（可能覆盖用户代码）；
 * 把「没落地」当成「已落地」→ 步骤被错误跳过。因此这里的规则是刻意保守的：
 *
 * - `sideEffect='none'`（只读工具、或中断发生在两次动作之间）→ 可自动继续；
 * - `sideEffect='write'` → **先验证产物**：`verification.kind='file'` 可自动 stat；
 *   验证通过 → 补记为完成（绝不重跑）；失败或无法验证 → 停下来要人确认；
 * - `sideEffect='unknown'`（审批挂起中、结果未知）→ 一律人工确认。
 *
 * 命令类验证（`kind='command'`）**故意不在 M3 自动执行**：那等于绕过审批通道跑任意 shell，
 * 属于 M4 的完成工具（它有工具调用与审批链路）。这里只做只读的 stat。
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { ApiError } from '../errors.js';
import { classifyBashCommand } from './tool-approval.js';
import {
  currentStep,
  isInterrupted,
  type TaskRecord,
  type TaskStep,
} from './platform/task-model.js';
import { leaseView, type LeaseView } from './task-lease.js';
import type { TaskService } from './task-service.js';

/** 恢复动作：可自动继续 / 需先验证产物 / 只能人工确认。 */
export type RecoveryAction = 'auto_resume' | 'verify_then_resume' | 'manual_only';

/** 副作用等级：none（只读） / write（有写入） / unknown（未知）。 */
export type SideEffect = 'none' | 'write' | 'unknown';

/** 只读工具：这些工具名不可能改工作区。 */
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob', 'search', 'questionnaire']);
/** 写类工具：默认按「会写」处理。 */
const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit']);

/**
 * 判定一次工具调用的副作用等级。
 *
 * 中文说明：`bash` 用**审批规则**来判定而不是白名单关键词——`classifyBashCommand` 已经知道
 * 哪些命令危险/敏感（删除、重定向写、依赖变更…），命中即视为写；没命中的普通命令
 * 仍可能是写（例如 `python -c "open(...)"`），但那时更合理的做法是标成 unknown 而不是 none：
 * 宁可多要一次人工确认，也不要自动重放。
 */
export function classifySideEffect(toolName: string, args: unknown): SideEffect {
  if (READ_ONLY_TOOLS.has(toolName)) return 'none';
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (toolName === 'bash') {
    const approval = classifyBashCommand(args);
    if (approval) return 'write';
    // 未命中规则：既不能证明只读，也不能证明会写。
    return 'unknown';
  }
  // MCP 工具与未来新增工具：无法证明只读 → unknown。
  return 'unknown';
}

/** 恢复清单里的一项。 */
export interface TaskRecoveryItem {
  taskId: string;
  title: string;
  goal: string;
  status: TaskRecord['status'];
  sessionId?: string;
  cwd?: string;
  attempt: number;
  updatedAt: string;
  lastHeartbeatAt?: string;
  lease: LeaseView;
  /** 中断时刻正在进行的动作（若有）。 */
  inFlightTool?: string;
  step?: { id: string; title: string; status: TaskStep['status'] };
  sideEffect: SideEffect;
  action: RecoveryAction;
  /** 人类可读的恢复建议/限制说明。 */
  reason: string;
  /** 可自动验证的产物（`verification.kind='file'` 时）。 */
  artifact?: { path: string; exists: boolean };
  /** 恢复所需的确认（`manual_only`、或写副作用但无法验证时）。 */
  requiresConfirmation: boolean;
}

/** 一次恢复请求的参数。 */
export interface ResumeRequest {
  mode: 'continue' | 'retry_step' | 'replan';
  /** 人工确认已了解副作用风险（`manual_only` / 无法验证的写副作用时必须显式给）。 */
  confirmSideEffect?: boolean;
}

/**
 * 恢复服务：产出恢复清单，并判定某个任务能否按指定方式恢复。
 * 中文说明：**只读**——不修改任务状态（除了「验证失败 → 标记 blocked」这一步，
 * 它必须落库才能让用户看见问题）。
 */
export class TaskRecoveryService {
  constructor(
    private readonly tasks: TaskService,
    private readonly options: { owner: string; now?: () => number; projectRoot?: string },
  ) {}

  /** 扫描所有疑似中断的任务（启动时调用，也可随时查询）。 */
  scan(): TaskRecoveryItem[] {
    const now = this.nowMs();
    return this.tasks
      .list({ limit: 500 })
      .filter((task) => isInterrupted(task, now))
      .map((task) => this.describe(task));
  }

  /** 单个任务的恢复说明（不存在 → 404；不需恢复 → 409）。 */
  describeItem(taskId: string): TaskRecoveryItem {
    return this.describe(this.tasks.get(taskId));
  }

  /**
   * 校验某个任务能否按 mode 恢复。
   * 中文说明：验证失败会**落库为 blocked**（用户需要看到「产物状态未知」），再抛错。
   * 抛错是必要的：resume 绝不能在不满足前提时静默开始跑。
   */
  assertResumable(item: TaskRecoveryItem, request: ResumeRequest): void {
    // 先判「请求本身支持不支持」：不支持的 mode 不该被任务状态的问题掩盖。
    if (request.mode === 'replan') {
      // M4 的 Plan 重构会接管这条路径（提交新计划 → 覆盖步骤）。
      throw new ApiError(
        409,
        'replan_unavailable',
        'replan will be provided by the M4 plan refactor; use continue or retry_step',
      );
    }
    if (item.status === 'completed' || item.status === 'cancelled') {
      throw new ApiError(409, 'task_not_resumable', `Task is ${item.status} and cannot be resumed`);
    }
    if (item.lease.heldByOther) {
      throw new ApiError(409, 'task_leased', 'Task is being executed by another process', {
        owner: item.lease.owner,
        expiresAt: item.lease.expiresAt,
      });
    }
    if (item.sessionId === undefined) {
      throw new ApiError(
        409,
        'task_session_missing',
        'Task is not bound to a session; resume needs a session to continue in',
      );
    }
    if (item.step === undefined) {
      // 没有可推进的步骤（空步骤，或全部 skipped）：让模型去猜“要做啥”不如让用户先补步骤。
      throw new ApiError(
        409,
        'task_not_resumable',
        'Task has no pending step to work on; add a step before resuming',
      );
    }
    if (item.action === 'manual_only' && request.confirmSideEffect !== true) {
      throw new ApiError(
        409,
        'task_needs_confirmation',
        `Resume requires explicit confirmation: ${item.reason}`,
        { sideEffect: item.sideEffect, step: item.step?.id, artifact: item.artifact },
      );
    }
    // 产物验证不在这里判定：产物缺失要**把任务标成 blocked**（让用户看见），
    // 那是执行器的职责（见 task-runner.ts），它会在这之后抛 409 task_artifact_unverified。
  }

  /** 应用「文件类产物」验证：通过则把当前步骤补记为完成。 */
  applyArtifactVerification(item: TaskRecoveryItem): { verified: boolean; detail: string } {
    const artifact = item.artifact;
    if (artifact === undefined || item.step === undefined) {
      return { verified: false, detail: '没有可验证的产物声明' };
    }
    if (artifact.exists) {
      this.tasks.completeStepWithEvidence(item.taskId, item.step.id, {
        summary: `恢复时验证产物已存在：${artifact.path}`,
        toolCallIds: [],
        filesTouched: [artifact.path],
      });
      return { verified: true, detail: `产物已存在：${artifact.path}` };
    }
    return { verified: false, detail: `产物不存在：${artifact.path}` };
  }

  /** 把中断信息落成 blocked（用户可见），并释放可能残留的租约。 */
  markInterrupted(taskId: string, reason: string): TaskRecord {
    return this.tasks.markInterrupted(taskId, reason, this.options.owner);
  }

  private describe(task: TaskRecord): TaskRecoveryItem {
    const now = this.nowMs();
    const execution = task.execution;
    const step = currentStep(task.steps);
    const inFlight = execution.inFlight;
    // 在飞动作优先；否则用 lastSideEffect（仅当它属于当前步骤的本次尝试）。
    const sideEffect = this.effectiveSideEffect(task, step, now);
    const artifact = this.artifactOf(task, step);
    const action: RecoveryAction =
      sideEffect === 'none'
        ? 'auto_resume'
        : sideEffect === 'write' && artifact !== undefined
          ? 'verify_then_resume'
          : 'manual_only';
    return {
      taskId: task.id,
      title: task.title,
      goal: task.goal,
      status: task.status,
      ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
      ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
      attempt: execution.attempt,
      updatedAt: task.updatedAt,
      ...(execution.lastHeartbeatAt === undefined
        ? {}
        : { lastHeartbeatAt: execution.lastHeartbeatAt }),
      lease: leaseView(execution, this.options.owner, now),
      ...(inFlight?.toolName === undefined ? {} : { inFlightTool: inFlight.toolName }),
      ...(step === undefined
        ? {}
        : { step: { id: step.id, title: step.title, status: step.status } }),
      sideEffect,
      action,
      reason: describeReason(action, sideEffect, inFlight?.toolName),
      ...(artifact === undefined ? {} : { artifact }),
      // 「需要确认」= 执行器真的会要人点头的场景：
      // manual_only 一定要；verify_then_resume 只在产物**不在**时才要（在就直接补记完成）。
      requiresConfirmation:
        action === 'manual_only' || (artifact?.exists !== true && action === 'verify_then_resume'),
    };
  }

  private effectiveSideEffect(
    task: TaskRecord,
    step: TaskStep | undefined,
    now: number,
  ): SideEffect {
    const execution = task.execution;
    if (execution.inFlight !== undefined) return execution.inFlight.sideEffect;
    const last = execution.lastSideEffect;
    if (last === undefined) return 'none';
    // 只在「属于当前步骤的本次尝试」时才算数：步骤被重置/重跑后 startedAt 更新，旧标记自然失效。
    if (step !== undefined && last.stepId !== undefined && last.stepId !== step.id) return 'none';
    if (step?.startedAt !== undefined && Date.parse(last.at) < Date.parse(step.startedAt)) {
      return 'none';
    }
    void now;
    return last.sideEffect;
  }

  private artifactOf(
    task: TaskRecord,
    step: TaskStep | undefined,
  ): { path: string; exists: boolean } | undefined {
    const verification = step?.verification;
    if (verification === undefined || verification.kind !== 'file' || !verification.path) {
      return undefined;
    }
    const path = isAbsolute(verification.path)
      ? verification.path
      : resolve(task.cwd ?? this.options.projectRoot ?? process.cwd(), verification.path);
    // 只做只读 stat：不创建、不修改、不跟随写操作。
    return { path, exists: existsSync(path) };
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function describeReason(action: RecoveryAction, sideEffect: SideEffect, toolName?: string): string {
  switch (action) {
    case 'auto_resume':
      return '中断发生在两次动作之间（没有未决副作用），可安全继续。';
    case 'verify_then_resume':
      return `中断时正在执行写操作${toolName ? `（${toolName}）` : ''}；将先验证产物，存在则补记为已完成，不重跑。`;
    case 'manual_only':
      return sideEffect === 'write'
        ? `中断时正在执行写操作${toolName ? `（${toolName}）` : ''}，且没有可自动验证的产物声明；必须人工确认后才能继续。`
        : `中断时正在执行无法判定副作用的操作${toolName ? `（${toolName}）` : ''}；必须人工确认后才能继续。`;
  }
}

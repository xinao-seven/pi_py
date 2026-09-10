/**
 * 任务续跑执行器（M3）。
 *
 * 中文说明：`resume` 做四件事，顺序不能换：
 * 1. **校验**（恢复服务）：能续跑吗？需要人工确认吗？（不满足就 409，绝不静默开跑）
 * 2. **取租约**：防双跑。取不到就说明别的进程在跑，任务只读。
 * 3. **恢复上下文注入**：把 `[TASK RESUME]` 摘要交给跟踪器，由扩展在 `before_agent_start`
 *    以 `display: false` 的自定义消息注入（模型看得到、界面不显示），随后发一条 prompt 让模型继续。
 * 4. **保活**：启动租约续期；`agent_settled` 时释放租约并停续期。
 *
 * HTTP 语义：`POST /api/tasks/:id/resume` 返回 202——续跑是长任务，结果通过 SSE 观察，
 * 与 prompt 一致，不阻塞请求。
 */

import { ApiError } from '../errors.js';
import type { ServiceLogger } from './service-logger.js';
import { sortSteps, type TaskRecord } from './platform/task-model.js';
import type { AgentRegistry } from './agent-registry.js';
import { DEFAULT_LEASE_TTL_MS, DEFAULT_RENEW_INTERVAL_MS, TaskLeaseKeeper } from './task-lease.js';
import type { ResumeRequest, TaskRecoveryItem, TaskRecoveryService } from './task-recovery.js';
import type { TaskInFlightTracker } from './task-recovery-extension.js';
import type { TaskService } from './task-service.js';

export interface TaskRunnerOptions {
  tasks: TaskService;
  recovery: TaskRecoveryService;
  registry: AgentRegistry;
  tracker: TaskInFlightTracker;
  /** 本进程的租约 owner（pid + bootId）。 */
  owner: string;
  logger?: ServiceLogger;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  /** M5：任务停手时级联停掉子任务（只依赖一个方法，避免与 SubagentService 硬耦合）。 */
  subagents?: { abortAll(parentSessionId: string, reason?: string): void };
}

export interface ResumeOutcome {
  task: TaskRecord;
  item: TaskRecoveryItem;
  /** 实际发给会话的指令（注入的摘要不含在这里，它走隐藏上下文）。 */
  prompt: string;
}

interface ActiveRun {
  taskId: string;
  sessionId: string;
  keeper: TaskLeaseKeeper;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 任务续跑执行器：`resume`（崩溃恢复）与 `start`（计划开始/继续执行）共用同一套租约与绑定。 */
export class TaskRunner {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly options: TaskRunnerOptions) {}

  /** 续跑一个任务：校验 → 取租约 → 注入恢复上下文并发出提示。 */
  async resume(taskId: string, request: ResumeRequest): Promise<ResumeOutcome> {
    const { tasks, recovery, registry, tracker } = this.options;
    const item = recovery.describeItem(taskId);
    recovery.assertResumable(item, request);

    // 先取租约：取不到就别做任何后续动作。
    let task = tasks.acquireLease(taskId, this.options.owner, {
      attempt: item.attempt + 1,
      ...(this.options.leaseTtlMs === undefined ? {} : { ttlMs: this.options.leaseTtlMs }),
    });

    // 未决的写副作用：先验证产物。
    // 通过 → 补记完成（绝不重跑）；不通过 → 只有用户显式选择「重试该步骤」才继续，
    // 否则把任务标成 blocked 并报错（宁可停下，也不要重复写）。
    let sideEffectNote: string | undefined;
    if (item.action === 'verify_then_resume') {
      const verified = recovery.applyArtifactVerification(item);
      if (verified.verified) {
        sideEffectNote = `已验证并补记完成：${verified.detail}（不要重跑该步骤）`;
      } else if (request.mode === 'retry_step') {
        sideEffectNote = `产物未找到（${verified.detail}）：用户已选择重试，请先核对工作区实际状态再执行`;
      } else {
        tasks.releaseLease(taskId, this.options.owner);
        const blocked = recovery.markInterrupted(
          taskId,
          `上次执行中断，产物状态需人工确认：${verified.detail}`,
        );
        throw new ApiError(
          409,
          'task_artifact_unverified',
          blocked.blockedReason ?? verified.detail,
          {
            artifact: item.artifact,
          },
        );
      }
    } else if (item.action === 'manual_only') {
      sideEffectNote = '用户已确认知悉上次中断的副作用风险：继续前先核对现场，不要盲目重放写操作';
    }

    // 会话必须能打开（文件被删 → 明确报错并把任务标为 blocked，而不是崩掉）。
    const sessionId = item.sessionId as string;
    try {
      await registry.open(sessionId);
    } catch (error) {
      tasks.releaseLease(taskId, this.options.owner);
      recovery.markInterrupted(taskId, '会话文件不存在，无法续跑；请重新开始或手工处理');
      throw new ApiError(
        409,
        'task_session_missing',
        `Session ${sessionId} cannot be opened: ${messageOf(error)}`,
      );
    }

    // retry_step：把当前步骤重置回 pending 再继续。
    // replan（M4）：把计划打回草稿，让模型用 update_plan/submit_plan 重新提交计划。
    if (request.mode === 'retry_step') task = tasks.resetCurrentStep(taskId);
    else if (request.mode === 'replan' && task.origin === 'plan')
      task = tasks.setPlanState(taskId, { status: 'drafting' });
    else task = tasks.get(taskId);

    // 绑定会话与任务，并登记一次性恢复摘要。
    tracker.track(sessionId, taskId);
    tracker.setPendingResume(sessionId, buildResumeContext(task, item, request, sideEffectNote));

    // 保活：续期失败只记日志（真正的双跑由 acquire 拦截）。
    const keeper = new TaskLeaseKeeper({
      renew: () =>
        tasks.renewLease(
          taskId,
          this.options.owner,
          this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
        ),
      onLost: (error) =>
        this.options.logger?.warn({ taskId, error: messageOf(error) }, 'task lease renew failed'),
      intervalMs: this.options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS,
    });
    keeper.start();
    this.active.set(taskId, { taskId, sessionId, keeper });

    const prompt = buildResumePrompt(task, request);
    try {
      // 与普通 prompt 一样：不 await 模型完成，202 先返回，过程走 SSE。
      await registry.command(sessionId, { type: 'prompt', message: prompt });
    } catch (error) {
      keeper.dispose();
      this.active.delete(taskId);
      tasks.releaseLease(taskId, this.options.owner);
      throw error;
    }
    return { task, item, prompt };
  }

  /**
   * 开始/继续执行一个任务（M4 的 plan_execute / plan_resume 走这里）。
   *
   * 中文说明：与 `resume` 的区别只在于「不做恢复判定、不注入一次性恢复摘要」——
   * 计划执行期的上下文由 Plan 扩展**每轮**注入（`[PLAN EXECUTING]`），
   * 所以这里只需要：取租约 → 绑定会话与任务（在飞动作才会记到任务上）→ 发一条可见 prompt。
   * 租约同样由 `handleSettled` 在 run 结算时释放，暂停时由 `stop()` 主动释放。
   */
  async start(taskId: string, prompt: string): Promise<TaskRecord> {
    const { tasks, registry, tracker } = this.options;
    const existing = tasks.get(taskId);
    if (existing.sessionId === undefined) {
      throw new ApiError(409, 'task_session_missing', 'Task is not bound to a session');
    }
    const sessionId = existing.sessionId;
    let task = tasks.acquireLease(taskId, this.options.owner, {
      ...(this.options.leaseTtlMs === undefined ? {} : { ttlMs: this.options.leaseTtlMs }),
    });
    try {
      await registry.open(sessionId);
    } catch (error) {
      tasks.releaseLease(taskId, this.options.owner);
      throw new ApiError(
        409,
        'task_session_missing',
        `Session ${sessionId} cannot be opened: ${messageOf(error)}`,
      );
    }
    tracker.track(sessionId, taskId);
    const keeper = new TaskLeaseKeeper({
      renew: () =>
        tasks.renewLease(
          taskId,
          this.options.owner,
          this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
        ),
      onLost: (error) =>
        this.options.logger?.warn({ taskId, error: messageOf(error) }, 'task lease renew failed'),
      intervalMs: this.options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS,
    });
    keeper.start();
    this.active.set(taskId, { taskId, sessionId, keeper });
    try {
      await registry.command(sessionId, { type: 'prompt', message: prompt });
    } catch (error) {
      keeper.dispose();
      this.active.delete(taskId);
      tasks.releaseLease(taskId, this.options.owner);
      throw error;
    }
    task = tasks.get(taskId);
    return task;
  }

  /** 主动停手（暂停/放弃计划）：停续期并释放租约，不留「还在跑」的假象。 */
  stop(taskId: string): void {
    const run = this.active.get(taskId);
    if (run === undefined) return;
    // 任务停手时，这个会话派出去的子任务也要停（M5）：否则「暂停计划」之后
    // 子任务还在跑，完成时又去改工作区，与「停手」矛盾。
    this.options.subagents?.abortAll(run.sessionId, '任务已停止');
    run.keeper.dispose();
    this.active.delete(taskId);
    try {
      this.options.tasks.releaseLease(taskId, this.options.owner);
    } catch (error) {
      this.options.logger?.warn({ taskId, error: messageOf(error) }, 'task lease release failed');
    }
  }

  /** run 结束（agent_settled）时释放租约并停续期。 */
  handleSettled(sessionId: string): void {
    for (const [taskId, run] of [...this.active]) {
      if (run.sessionId !== sessionId) continue;
      run.keeper.dispose();
      this.active.delete(taskId);
      try {
        this.options.tasks.releaseLease(taskId, this.options.owner);
      } catch (error) {
        this.options.logger?.warn({ taskId, error: messageOf(error) }, 'task lease release failed');
      }
    }
  }

  /** 当前正在被本进程续跑的任务（诊断/测试用）。 */
  activeTaskIds(): string[] {
    return [...this.active.keys()];
  }

  /**
   * 服务关闭：停续期并释放租约。
   * 中文说明：优雅退出不该留下「租约被占」的假象——租约过期靠 TTL，但主动释放更干净，
   * 下次启动的恢复扫描会立刻把仍在 in_progress 的任务列为待恢复（这是想要的）。
   */
  dispose(): void {
    for (const [taskId, run] of [...this.active]) {
      run.keeper.dispose();
      this.active.delete(taskId);
      try {
        this.options.tasks.releaseLease(taskId, this.options.owner);
      } catch {
        // 关闭路径不阻塞，也不抛。
      }
    }
  }
}

/** 生成隐藏的恢复摘要（`[TASK RESUME]`）。 */
export function buildResumeContext(
  task: TaskRecord,
  item: TaskRecoveryItem,
  request: ResumeRequest,
  sideEffectNote?: string,
): string {
  const steps = sortSteps(task.steps);
  const done = steps.filter((step) => step.status === 'completed' || step.status === 'skipped');
  const pending = steps.filter((step) => step.status !== 'completed' && step.status !== 'skipped');
  const lines: string[] = [
    '[TASK RESUME]',
    `任务：${task.title}`,
    `目标：${task.goal}`,
    `状态：${task.status}（第 ${task.execution.attempt} 次尝试，模式：${request.mode}）`,
  ];
  if (done.length > 0) {
    lines.push('已完成步骤：');
    for (const step of done) {
      const evidence = step.evidence?.summary ?? step.evidence?.commands?.[0]?.command;
      lines.push(`  - [${step.id}] ${step.title}${evidence ? `｜证据：${evidence}` : ''}`);
    }
  }
  if (item.step !== undefined) {
    lines.push(`当前步骤：[${item.step.id}] ${item.step.title}（${item.step.status}）`);
  }
  if (pending.length > 1) {
    lines.push(
      `后续步骤：${pending
        .slice(1)
        .map((step) => `[${step.id}] ${step.title}`)
        .join('；')}`,
    );
  }
  lines.push(`中断说明：${item.reason}`);
  if (item.inFlightTool) lines.push(`中断时正在执行：${item.inFlightTool}`);
  if (sideEffectNote) lines.push(`副作用处理：${sideEffectNote}`);
  lines.push(
    '要求：',
    '- 先复述当前状态与已完成的工作，确认没有冲突，再继续；',
    '- 只推进当前步骤；已完成的步骤不要重做；',
    '- 完成一步后如实汇报结果与证据，不要声称未验证的事情已经完成。',
  );
  return lines.join('\n');
}

/** 生成发给会话的可见指令（细节在被注入的隐藏摘要里）。 */
export function buildResumePrompt(task: TaskRecord, request: ResumeRequest): string {
  if (request.mode === 'retry_step')
    return `重试任务「${task.title}」的当前步骤。先按 [TASK RESUME] 复述状态，再重新执行这一步。`;
  if (request.mode === 'replan')
    return `重新规划任务「${task.title}」：先按 [TASK RESUME] 复述中断前的状态，再用 update_plan（或 submit_plan）提交修订后的计划，然后停下等用户确认。`;
  return `继续任务「${task.title}」。先按 [TASK RESUME] 复述状态，再推进当前步骤。`;
}

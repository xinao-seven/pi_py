/**
 * 任务恢复的内联扩展（M3）：把 agent 生命周期事件翻译成任务的「在飞动作」。
 *
 * 中文说明：为什么用内联扩展而不是账本？
 * - 在飞动作是**任务状态**（要落库、断点续跑依赖它），不是观测明细——即使 trace 关掉也必须记录；
 * - 扩展拿到的是 SDK 的原始钩子（turn_start / tool_execution_start / agent_settled），
 *   与 agent loop 同一条时间线，不需要把任务语义塞进账本。
 *
 * 同时承担恢复上下文的注入：`before_agent_start` 时把一次性的 `[TASK RESUME]` 摘要以
 * `display: false` 的自定义消息注入（与 plan-mode 的做法一致，模型看得到、界面不显示），
 * 并用 `context` 钩子保证同类型消息只留最后一条（否则每次恢复都会在 JSONL 里累积）。
 */

import type { ContextEvent, ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import type { InlineExtension as InlineExtensionType } from '@earendil-works/pi-coding-agent';

import type { ServiceLogger } from './service-logger.js';
import { currentStep } from './platform/task-model.js';
import { classifySideEffect } from './task-recovery.js';
import type { TaskService } from './task-service.js';

/** 恢复摘要的自定义消息类型（`context` 钩子按它清理）。 */
export const TASK_RESUME_CONTEXT_TYPE = 'task-resume';

export interface TaskInFlightOptions {
  /** 会话当前的绑定任务（通常是注册表的 activeTaskId）。 */
  lookupActiveTask?: (sessionId: string) => string | undefined;
  /** run 结束（agent_settled）时的回调：执行器用它释放租约。 */
  onSettled?: (sessionId: string) => void;
  logger?: ServiceLogger;
  /** 注入时间源（测试用；与 TaskService 用同一个时钟才能保证排序判断一致）。 */
  now?: () => Date;
}

/**
 * 在飞动作跟踪器：sessionId → taskId，并把工具调用写成任务的 `execution.inFlight`。
 *
 * 中文说明：所有方法都**不得抛错**——它们被 SDK 事件钩子调用，出错只能降级为 warn，
 * 否则会把 agent loop 弄挂。因此每个入口都包了 try/catch。
 */
export class TaskInFlightTracker {
  /** 执行器显式绑定的任务（resume 时设置），优先于注册表的 activeTaskId。 */
  private readonly bound = new Map<string, string>();
  /** 待注入的恢复摘要（一次性，注入后即取走）。 */
  private readonly pendingResume = new Map<string, string>();

  constructor(
    private readonly tasks: TaskService,
    private readonly options: TaskInFlightOptions = {},
  ) {}

  /** 绑定/解绑会话与任务（resume 前绑定，执行结束解绑）。 */
  track(sessionId: string, taskId: string | null): void {
    if (taskId === null) this.bound.delete(sessionId);
    else this.bound.set(sessionId, taskId);
  }

  /** 登记一次性的恢复摘要（下一次 `before_agent_start` 注入）。 */
  setPendingResume(sessionId: string, text: string): void {
    this.pendingResume.set(sessionId, text);
  }

  /** 取走恢复摘要（只注入一次）。 */
  takeResumeContext(sessionId: string): string | undefined {
    const text = this.pendingResume.get(sessionId);
    if (text === undefined) return undefined;
    this.pendingResume.delete(sessionId);
    return text;
  }

  noteTurnStart(sessionId: string): void {
    this.guard('turn_start', () => {
      const task = this.taskOf(sessionId);
      if (task === undefined) return;
      // 模型思考阶段没有副作用：中断在这里就是「两步之间」，可安全继续。
      this.tasks.setInFlight(task.id, {
        ...(currentStep(task.steps)?.id === undefined
          ? {}
          : { stepId: currentStep(task.steps)!.id }),
        kind: 'turn',
        startedAt: this.nowIso(),
        sideEffect: 'none',
      });
    });
  }

  noteToolStart(sessionId: string, toolName: string, toolCallId: string, args: unknown): void {
    this.guard('tool_start', () => {
      const task = this.taskOf(sessionId);
      if (task === undefined) return;
      const step = currentStep(task.steps);
      this.tasks.setInFlight(task.id, {
        ...(step === undefined ? {} : { stepId: step.id }),
        kind: 'tool',
        toolCallId,
        toolName,
        startedAt: this.nowIso(),
        sideEffect: classifySideEffect(toolName, args),
      });
    });
  }

  /**
   * 工具结束：清掉「正在执行」标记。
   * 中文说明：**只清 inFlight**——`lastSideEffect` 保留到该步骤的本次尝试结束，
   * 这样「写完文件、还没标记步骤完成就被杀」仍然会被判定为需要人工确认。
   */
  noteToolEnd(sessionId: string): void {
    this.guard('tool_end', () => {
      const task = this.taskOf(sessionId);
      if (task === undefined) return;
      this.tasks.setInFlight(task.id, null);
    });
  }

  /** run 结束：清掉在飞标记并通知执行器（释放租约）。 */
  noteSettled(sessionId: string): void {
    this.guard('settled', () => {
      const task = this.taskOf(sessionId);
      if (task !== undefined) this.tasks.setInFlight(task.id, null);
    });
    try {
      this.options.onSettled?.(sessionId);
    } catch (error) {
      this.logger()?.warn(
        { sessionId, error: error instanceof Error ? error.message : String(error) },
        'task settle listener failed',
      );
    }
  }

  /** 生成内联扩展（交给 OriginalPiSessionFactory 注入每个会话）。 */
  buildExtension(): InlineExtensionType {
    return buildTaskRecoveryExtension(this);
  }

  /** 会话关闭/删除时的清理。 */
  dispose(): void {
    this.bound.clear();
    this.pendingResume.clear();
  }

  private taskOf(sessionId: string) {
    const taskId = this.bound.get(sessionId) ?? this.options.lookupActiveTask?.(sessionId);
    if (taskId === undefined) return undefined;
    try {
      return this.tasks.get(taskId);
    } catch {
      return undefined; // 任务已被删除：静默忽略
    }
  }

  private logger(): ServiceLogger | undefined {
    return this.options.logger;
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private guard(action: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.logger()?.warn(
        { action, error: error instanceof Error ? error.message : String(error) },
        'task in-flight update skipped',
      );
    }
  }
}

/** 从扩展上下文取会话 id。 */
function sessionOf(ctx: unknown): string | undefined {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
    ?.sessionManager;
  try {
    return manager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

/** 保留最后一条 `task-resume` 注入消息（其余同类型丢弃），避免随恢复次数累积。 */
export function keepLastResumeContext(
  event: ContextEvent,
): { messages: ContextEvent['messages'] } | undefined {
  let lastIndex = -1;
  event.messages.forEach((message, index) => {
    if ((message as { customType?: unknown }).customType === TASK_RESUME_CONTEXT_TYPE) {
      lastIndex = index;
    }
  });
  if (lastIndex < 0) return undefined;
  const filtered = event.messages.filter((message, index) => {
    const isResume = (message as { customType?: unknown }).customType === TASK_RESUME_CONTEXT_TYPE;
    return !isResume || index === lastIndex;
  });
  return filtered.length === event.messages.length ? undefined : { messages: filtered };
}

/** 生成任务恢复的内联扩展。 */
export function buildTaskRecoveryExtension(tracker: TaskInFlightTracker): InlineExtension {
  return (pi: ExtensionAPI) => {
    pi.on('turn_start', (_event, ctx) => {
      const sessionId = sessionOf(ctx);
      if (sessionId) tracker.noteTurnStart(sessionId);
    });
    pi.on('tool_execution_start', (event, ctx) => {
      const sessionId = sessionOf(ctx);
      if (sessionId) tracker.noteToolStart(sessionId, event.toolName, event.toolCallId, event.args);
    });
    pi.on('tool_execution_end', (_event, ctx) => {
      const sessionId = sessionOf(ctx);
      if (sessionId) tracker.noteToolEnd(sessionId);
    });
    pi.on('agent_settled', (_event, ctx) => {
      const sessionId = sessionOf(ctx);
      if (sessionId) tracker.noteSettled(sessionId);
    });
    pi.on('before_agent_start', (_event, ctx) => {
      const sessionId = sessionOf(ctx);
      if (!sessionId) return undefined;
      const text = tracker.takeResumeContext(sessionId);
      return text === undefined
        ? undefined
        : { message: { customType: TASK_RESUME_CONTEXT_TYPE, content: text, display: false } };
    });
    pi.on('context', (event) => keepLastResumeContext(event));
  };
}

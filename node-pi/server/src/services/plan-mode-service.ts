/**
 * Web Plan 模式（M4）：工具驱动 + Task 支撑 + 能力集权限。
 *
 * 中文说明：这个模块在 M4 被重写，三处关键变化：
 *
 * 1. **不再解析自然语言**：删掉 `extractPlan()` / `markDone()` / `[DONE:n]`。
 *    计划的产出与推进全部走 `plan-tools.ts` 注册的结构化工具（P2 的根治）。
 * 2. **不再自己存状态**：计划的真相源是任务（`execution.plan` + 步骤），本模块只在内存里
 *    记住「哪个任务 id、加/删过哪些工具」。会话重新打开时从库里**采纳**未结束的计划
 *    （`activePlanForSession`），因此服务重启后计划依然在（P8），JSONL 里只留一条引用指针（P5）。
 * 3. **权限用能力集而非快照**：规划期按 `PlanPolicy` 分类放行（只读 + 验证类命令），
 *    退出时只**撤销自己造成的差集**，不写回旧快照——用户规划期间的改动不会被吞掉（P6）。
 *
 * 状态机的迁移条件全部来自用户动作（确认/暂停/放弃）或服务端校验（工具参数与证据），
 * 没有一条依赖模型「写了什么标记」。这是 M4 的核心承诺。
 */

import type { ContextEvent, ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import { ApiError } from '../errors.js';
import type { ServiceLogger } from './service-logger.js';
import {
  derivePlanStatus,
  emptyPlanView,
  planTitleFromMessage,
  toPlanView,
  type PlanView,
} from './platform/plan-model.js';
import { buildPlanTools, PLAN_TOOL_NAMES, PlanToolbox } from './plan-tools.js';
import { DEFAULT_PLAN_POLICY, evaluatePlanBash, type PlanPolicy } from './plan-policy.js';
import type { TaskRecord } from './platform/task-model.js';
import type { TaskService } from './task-service.js';

/** JSONL 里的计划引用指针（只在创建/采纳计划时写一次，不写状态快照）。 */
const PLAN_REF_CUSTOM_TYPE = 'web-plan-ref';
/** 旧的快照类型：只用于「忽略历史遗留条目」，不再写入。 */
const LEGACY_SNAPSHOT_TYPE = 'web-plan-mode';
const PLANNING_CONTEXT_TYPE = 'web-plan-context';
const EXECUTING_CONTEXT_TYPE = 'web-plan-execution-context';
/** 需要清理的旧类型（M4 之前注入过，历史会话里可能还在）。 */
const LEGACY_CONTEXT_TYPES = new Set(['web-plan-execute']);
const EMPTY_TYPES: ReadonlySet<string> = new Set();

const MCP_TOOL_PREFIX = 'mcp__';

/** 规划期一律禁止的工具（与 M4 之前一致，但现在只由能力集决定）。 */
const DEFAULT_BLOCKED_TOOLS = ['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit'];

/**
 * 规划期阻断的观测钩子（可选）。
 * 中文说明：SDK 把「被扩展拦下」和「工具执行失败」都表现为
 * `tool_execution_end(isError=true)`，所以主动上报一次阻断原因，
 * 账本才能把它归因为「策略生效」而不是「工具失败」。
 */
export interface PlanTraceSink {
  noteToolBlock(input: {
    sessionId: string;
    toolCallId: string;
    blockedBy: 'plan_mode';
    reason?: string;
  }): void;
}

export interface PlanModeServiceOptions {
  policy?: PlanPolicy;
  logger?: ServiceLogger;
}

/** 计划执行器（M4）：由 app 注入，负责「取租约 + 绑定会话 + 发执行 prompt」。 */
export interface PlanExecutor {
  start(taskId: string, prompt: string): Promise<TaskRecord>;
  stop(taskId: string): void;
}

/** 取一条上下文消息的 customType（非自定义消息返回 undefined）。 */
function customTypeOf(message: unknown): string | undefined {
  const customType = (message as { customType?: unknown } | null)?.customType;
  return typeof customType === 'string' ? customType : undefined;
}

interface SessionContext {
  cwd?: string;
  sessionManager: {
    getSessionId(): string;
    getEntries(): unknown[];
  };
}

/** 一个会话的计划状态机：持有工具差集，状态从任务派生。 */
class PlanSession {
  private sessionIdValue = '';
  private cwd: string | undefined;
  private planTaskId: string | undefined;
  /** 我们打开的工具（退出时关掉）与关掉的工具（退出时打开）——只撤销自己的差集。 */
  private toolsAdded: string[] = [];
  private toolsDisabled: string[] = [];

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly service: PlanModeService,
    private readonly toolbox: PlanToolbox,
    private readonly tasks: TaskService,
  ) {}

  /** 计划工具（工厂期注册；只有计划会话才把它们放进 activeTools）。 */
  registerTools(): void {
    for (const tool of buildPlanTools(this.toolbox)) this.pi.registerTool(tool);
  }

  /** session_start：绑定会话、采纳未结束的计划、按状态恢复权限并广播视图。 */
  attach(ctx: SessionContext): void {
    this.sessionIdValue = ctx.sessionManager.getSessionId();
    this.cwd = ctx.cwd ?? this.cwd;
    const adopted = this.service.adoptPlan(this.sessionId);
    this.bindPlan(adopted);
    this.service.register(this);
    this.publish();
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  /** 覆盖 cwd（创建计划时以会话 cwd 为准）。 */
  setCwd(cwd: string | undefined): void {
    this.cwd = cwd ?? this.cwd;
  }

  /** 当前计划（每次从库里读最新，规避持有过期副本）。 */
  current(): TaskRecord | undefined {
    return this.toolbox.current();
  }

  view(): PlanView {
    const task = this.current();
    return task === undefined ? emptyPlanView(this.sessionId) : toPlanView(task);
  }

  status() {
    const task = this.current();
    return task === undefined ? ('abandoned' as const) : derivePlanStatus(task);
  }

  isPlanning(): boolean {
    const status = this.status();
    return status === 'drafting' || status === 'proposed';
  }

  isExecuting(): boolean {
    return this.status() === 'executing';
  }

  /**
   * 开始规划（`mode: 'plan'` 的首条消息，或 `plan_start`）。
   * 已有未结束的计划时**采纳而不是新建**——用户多半想改计划，而不是丢掉它。
   */
  startPlanning(message: string): PlanView {
    const existing = this.current();
    if (existing !== undefined) {
      const status = derivePlanStatus(existing);
      if (status === 'paused' || status === 'proposed' || status === 'drafting') {
        // 回到草稿：允许 submit_plan 整体替换；已提出的澄清问题保留给模型参考。
        this.tasks.setPlanState(existing.id, { status: 'drafting' });
        this.applyPlanTools('planning');
        this.publish();
        return this.view();
      }
    }
    const task = this.tasks.createPlan({
      title: planTitleFromMessage(message),
      goal: message,
      sessionId: this.sessionId,
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
    });
    this.bindPlan(task);
    this.applyPlanTools('planning');
    this.appendRef(task);
    this.publish();
    return this.view();
  }

  /** 采纳/切换当前计划：绑定工具箱与权限。 */
  bindPlan(task: TaskRecord | undefined): void {
    this.planTaskId = task?.id;
    this.toolbox.bind(task?.id);
    if (task === undefined) {
      this.restorePlanTools();
      return;
    }
    const status = derivePlanStatus(task);
    this.applyPlanTools(status === 'executing' ? 'executing' : 'planning');
    if (status === 'completed' || status === 'abandoned') this.restorePlanTools();
  }

  /** 进入执行态：恢复被拦的工具，保留计划工具。 */
  enterExecution(): void {
    this.applyPlanTools('executing');
    this.publish();
  }

  /** 计划结束（完成/放弃）：撤销工具差集。 */
  exitPlan(): void {
    this.restorePlanTools();
    this.publish();
  }

  /**
   * tool_call：规划期按能力集拦截。
   * 中文说明：这是「权限」的最终约束点——即使某个工具还在 activeTools 里
   * （例如用户手动打开过），规划期的写操作依然会被这里拦下。
   */
  onToolCall(event: {
    toolName: string;
    toolCallId: string;
    input: unknown;
  }): { block: true; reason: string } | undefined {
    const block = this.evaluateToolCall(event);
    if (block) this.service.noteBlock(this.sessionId, event.toolCallId, block.reason);
    return block;
  }

  private evaluateToolCall(event: {
    toolName: string;
    toolCallId: string;
    input: unknown;
  }): { block: true; reason: string } | undefined {
    // 只有规划期（草稿/待确认）是只读的：执行期该写就写。
    if (!this.isPlanning()) return undefined;
    const policy = this.service.policy;
    if (DEFAULT_BLOCKED_TOOLS.includes(event.toolName))
      return {
        block: true,
        reason:
          'Plan mode is read-only while the plan is not confirmed. Ask the user to confirm execution (plan_execute) before editing files.',
      };
    if (event.toolName.startsWith(MCP_TOOL_PREFIX) && !policy.allowMcp)
      return {
        block: true,
        reason:
          'Plan mode does not allow MCP tools (read-onlyness cannot be proven). Confirm the plan first, or ask the user to allow MCP in the plan policy.',
      };
    if (event.toolName === 'bash') {
      const verdict = evaluatePlanBash((event.input as { command?: unknown }).command, policy);
      if (!verdict.allowed) return { block: true, reason: verdict.reason };
    }
    return undefined;
  }

  /**
   * context：清理过期的 plan 注入，并把当前模式注入压到**仅最后一条**。
   * 中文说明：`before_agent_start` 每轮都会注入一条，而消息会持久化进 JSONL，
   * 不清理会随轮数线性膨胀；同时历史里会残留与当前状态矛盾的指令。
   */
  onContext(event: ContextEvent): { messages: ContextEvent['messages'] } | undefined {
    const keep: ReadonlySet<string> = this.isPlanning()
      ? new Set([PLANNING_CONTEXT_TYPE])
      : this.isExecuting()
        ? new Set([EXECUTING_CONTEXT_TYPE])
        : EMPTY_TYPES;
    const lastIndex = new Map<string, number>();
    event.messages.forEach((message, index) => {
      const customType = customTypeOf(message);
      if (customType !== undefined && keep.has(customType)) lastIndex.set(customType, index);
    });
    const filtered = event.messages.filter((message, index) => {
      const customType = customTypeOf(message);
      if (customType === undefined) return true;
      // M4 之前的旧注入类型一律丢弃（它们描述的是已废弃的状态机）。
      if (LEGACY_CONTEXT_TYPES.has(customType)) return false;
      if (!keep.has(customType)) return false;
      return lastIndex.get(customType) === index;
    });
    return filtered.length === event.messages.length ? undefined : { messages: filtered };
  }

  /** before_agent_start：注入当前计划上下文（隐藏消息，模型可见、界面不显示）。 */
  beforeAgentStart():
    { message: { customType: string; content: string; display: boolean } } | undefined {
    const task = this.current();
    if (task === undefined) return undefined;
    if (this.isPlanning())
      return {
        message: {
          customType: PLANNING_CONTEXT_TYPE,
          display: false,
          content: buildPlanningContext(task, this.service.policy),
        },
      };
    if (this.isExecuting())
      return {
        message: {
          customType: EXECUTING_CONTEXT_TYPE,
          display: false,
          content: buildExecutingContext(task),
        },
      };
    return undefined;
  }

  /**
   * 状态变化后广播视图（服务层转成 SSE `plan_updated`）。
   * 中文说明：计划自然跑完（步骤全完成）时不会有「退出计划」的显式动作，
   * 因此在这里顺手收回计划工具——否则 `submit_plan` 会永远留在 activeTools 里，
   * 变成「已经在做的计划旁边还挂着一个可随时新建计划的入口」。
   */
  publish(): void {
    const status = this.status();
    if ((status === 'completed' || status === 'abandoned') && this.toolsAdded.length > 0) {
      this.restorePlanTools();
    }
    this.service.publishState(this.view());
  }

  private appendRef(task: TaskRecord): void {
    try {
      this.pi.appendEntry(PLAN_REF_CUSTOM_TYPE, {
        planId: task.id,
        taskId: task.id,
        sessionId: this.sessionId,
      });
    } catch {
      // 指针只是给 CLI/审计用的痕迹，写不进去不影响计划本身（真相源在任务库）。
    }
  }

  /** 记录并应用工具差集。 */
  private applyPlanTools(mode: 'planning' | 'executing'): void {
    const policy = this.service.policy;
    const blocked = new Set([
      ...DEFAULT_BLOCKED_TOOLS,
      ...(policy.allowMcp ? [] : this.mcpToolNames()),
    ]);
    const active = new Set(this.pi.getActiveTools());
    if (mode === 'planning') {
      for (const name of [...active]) {
        if (!blocked.has(name)) continue;
        active.delete(name);
        if (!this.toolsDisabled.includes(name)) this.toolsDisabled.push(name);
      }
    } else {
      // 执行态：把规划期关掉的工具打开（仅限我们自己关的那些）。
      for (const name of this.toolsDisabled) active.add(name);
      this.toolsDisabled = [];
    }
    for (const name of PLAN_TOOL_NAMES) {
      if (!active.has(name)) active.add(name);
      // 即使已经在 activeTools 里也要登记（可能是上一个计划周期留下的，
      // 或者用户自己开过）：计划结束后必须由我们收回，不能只撤销「这次新加的」。
      if (!this.toolsAdded.includes(name)) this.toolsAdded.push(name);
    }
    this.pi.setActiveTools([...active]);
  }

  /**
   * 撤销工具差集（P6：只撤销自己造成的改动）。
   * 中文说明：不写回旧快照——规划期间用户通过 `set_tools` 关掉的工具必须保持关闭。
   * 已不在 activeTools 里的名字不做处理（用户可能已经手动改回来了）。
   */
  private restorePlanTools(): void {
    if (this.toolsAdded.length === 0 && this.toolsDisabled.length === 0) return;
    const active = new Set(this.pi.getActiveTools());
    for (const name of this.toolsAdded) active.delete(name);
    for (const name of this.toolsDisabled) active.add(name);
    this.toolsAdded = [];
    this.toolsDisabled = [];
    this.pi.setActiveTools([...active]);
  }

  /** 当前会话里名字像 MCP 的工具（规划期默认拦下，无法证明只读）。 */
  private mcpToolNames(): string[] {
    try {
      return this.pi.getActiveTools().filter((name) => name.startsWith(MCP_TOOL_PREFIX));
    } catch {
      return [];
    }
  }
}

/** 规划期隐藏上下文：说清「现在只读、产出方式是调用工具」。 */
export function buildPlanningContext(task: TaskRecord, policy: PlanPolicy): string {
  const view = toPlanView(task);
  const lines: string[] = [
    '[PLAN MODE ACTIVE]',
    `计划：${view.title}（planId=${view.planId}，revision=${view.revision}，状态=${view.status}）`,
    '你现在处于**只读规划期**：可以调研、读代码、跑验证类命令，但不要修改工作区。',
    '',
    '产出计划的方式是**调用工具**，不是写 `Plan:` 标题或编号列表：',
    '- 调研完成后调用 `submit_plan` 提交（或 `update_plan` 修订）结构化计划，每步尽量可验证（verification）。',
    '- 需要用户拍板时调用 `ask_user` 提问，然后结束本轮等回复。',
    '',
    `可用命令：${policy.bash === 'none' ? '（本会话禁止执行命令）' : '只读命令与验证类命令（如类型检查、测试、构建）'}；写操作请等用户确认计划后再做。`,
  ];
  if (view.steps.length > 0) {
    lines.push('', '当前计划步骤：');
    for (const step of view.steps) {
      lines.push(`- [${step.id}] ${step.title}（${step.status}）`);
    }
  } else {
    lines.push('', '当前还没有提交任何步骤：请调研后调用 `submit_plan`。');
  }
  // 「Agent 正在等用户回答提问」不在计划上下文里：提问是独立通道，
  // 由 ask_user 工具自己挂起并回收答案（见 docs/node-question-channel.md）。
  return lines.join('\n');
}

/** 执行期隐藏上下文：列出步骤与推进方式（每轮刷新，状态永远是最新的）。 */
export function buildExecutingContext(task: TaskRecord): string {
  const view = toPlanView(task);
  const done = view.steps.filter(
    (step) => step.status === 'completed' || step.status === 'skipped',
  );
  const remaining = view.steps.filter(
    (step) => step.status !== 'completed' && step.status !== 'skipped',
  );
  const lines: string[] = [
    '[PLAN EXECUTING]',
    `计划：${view.title}（planId=${view.planId}，revision=${view.revision}）`,
    `进度：${done.length}/${view.steps.length} 步完成`,
  ];
  if (done.length > 0) {
    lines.push('已完成：');
    for (const step of done) {
      const evidence = step.evidence?.summary ?? step.evidence?.commands?.[0]?.command;
      lines.push(`- [${step.id}] ${step.title}${evidence ? `｜证据：${evidence}` : ''}`);
    }
  }
  if (remaining.length > 0) {
    lines.push('待推进：');
    for (const step of remaining) {
      const need =
        step.verification?.kind === 'file'
          ? `（需产物 ${step.verification.path ?? '?'}）`
          : step.verification?.kind === 'command'
            ? `（需命令 ${step.verification.command ?? '?'} 退出码 ${step.verification.expectExitCode ?? 0}）`
            : '';
      lines.push(`- [${step.id}] ${step.title}（${step.status}）${need}`);
    }
  }
  lines.push(
    '',
    '推进方式（必须用工具，不要用文字声称完成）：',
    '- 完成一步 → `complete_step`，带真实证据（summary / commands + 退出码 / files）；声明了 verification 的步骤服务端会校验。',
    '- 无法继续 → `block_step` 说明原因，然后停下等用户处理，不要绕路或伪造完成。',
    '- 需要改计划 → `update_plan`（带当前 revision）。',
  );
  return lines.join('\n');
}

/** Web Plan 模式服务：按会话持有状态机，向注册表转发计划视图。 */
export class PlanModeService {
  private readonly sessions = new Map<string, PlanSession>();
  private listener: ((plan: PlanView) => void) | undefined;
  private trace: PlanTraceSink | undefined;
  private tasks: TaskService | undefined;
  private executor: PlanExecutor | undefined;
  readonly policy: PlanPolicy;

  constructor(private readonly options: PlanModeServiceOptions = {}) {
    this.policy = options.policy ?? DEFAULT_PLAN_POLICY;
  }

  /** 注入任务服务（计划就是任务，没有它无法工作）。 */
  setTaskService(tasks: TaskService): void {
    this.tasks = tasks;
  }

  /** 注入执行器（计划执行走它的租约与绑定）。 */
  setExecutor(executor: PlanExecutor): void {
    this.executor = executor;
  }

  /** 生成「Web Plan 模式」内联扩展：每个会话一套钩子 + 五个计划工具。 */
  buildExtension(): InlineExtension {
    return (pi: ExtensionAPI) => {
      const toolbox = new PlanToolbox({ tasks: this.requireTasks(), sessionId: '' });
      const session = new PlanSession(pi, this, toolbox, this.requireTasks());
      // 工具写入后立即广播新视图（计划状态的主要写入者是工具，不是 app 层桥接）。
      toolbox.setOnChanged(() => session.publish());
      session.registerTools();
      pi.on('session_start', (_event, ctx) => session.attach(ctx as SessionContext));
      pi.on('tool_call', (event) => session.onToolCall(event));
      pi.on('context', (event) => session.onContext(event));
      pi.on('before_agent_start', () => session.beforeAgentStart());
    };
  }

  setListener(listener: (plan: PlanView) => void): void {
    this.listener = listener;
  }

  setTraceSink(sink: PlanTraceSink): void {
    this.trace = sink;
  }

  /** 上报一次规划期阻断（观测失败不得影响拦截结果）。 */
  noteBlock(sessionId: string, toolCallId: string, reason: string): void {
    try {
      this.trace?.noteToolBlock({ sessionId, toolCallId, blockedBy: 'plan_mode', reason });
    } catch {
      // 可观测性是增量能力，静默降级。
    }
  }

  /** 会话当前计划视图（无计划时返回空视图，`planId` 为空串）。 */
  view(sessionId: string): PlanView {
    return this.sessions.get(sessionId)?.view() ?? this.viewFromStore(sessionId);
  }

  /** 兼容旧调用点：`/api/agent/:id` 的 `plan` 字段现在返回 PlanView。 */
  state(sessionId: string): PlanView {
    return this.view(sessionId);
  }

  /** 开始规划（`mode:'plan'` 或 `plan_start`）。 */
  startPlanning(sessionId: string, message: string): PlanView {
    const session = this.requireSession(sessionId);
    return session.startPlanning(message);
  }

  /** 采纳会话里未结束的计划（会话打开时调用；失败不抛，降级为「当前无计划」）。 */
  adoptPlan(sessionId: string): TaskRecord | undefined {
    try {
      return this.tasks?.activePlanForSession(sessionId);
    } catch (error) {
      this.options.logger?.warn(
        { sessionId, error: error instanceof Error ? error.message : String(error) },
        'plan adoption failed',
      );
      return undefined;
    }
  }

  /** 计划/任务状态变化后的广播入口（任务监听器也会调用它刷新面板）。 */
  refresh(sessionId: string): void {
    this.sessions.get(sessionId)?.publish();
  }

  /** 结束会话（注册表 remove 时调用）。 */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.exitPlan();
    this.sessions.delete(sessionId);
  }

  /** 下发 Plan 命令：校验当前状态后委托给对应会话的状态机 / 执行器。 */
  async command(
    sessionId: string,
    action: 'start' | 'execute' | 'pause' | 'resume' | 'refine' | 'abandon',
    message?: string,
  ): Promise<PlanView> {
    const session = this.requireSession(sessionId);
    const task = session.current();
    const status = session.status();
    switch (action) {
      case 'start': {
        if (!message?.trim())
          throw new ApiError(
            422,
            'validation_error',
            'A message is required to start planning (or send a prompt with mode="plan")',
          );
        return session.startPlanning(message.trim());
      }
      case 'refine': {
        if (task === undefined)
          throw new ApiError(409, 'plan_unavailable', 'No plan is active in this session');
        if (!message?.trim())
          throw new ApiError(422, 'validation_error', 'A refinement message is required');
        // 修订只是把用户意见交给模型，模型用 update_plan 落地（状态仍由服务端校验）。
        session.setCwd(task.cwd);
        this.requireTasks().setPlanState(task.id, { status: 'drafting' });
        session.publish();
        return session.view();
      }
      case 'execute': {
        if (task === undefined)
          throw new ApiError(409, 'plan_unavailable', 'No plan is active in this session');
        if (status === 'executing') return session.view();
        if (status !== 'proposed' && status !== 'paused')
          throw new ApiError(
            409,
            'plan_not_ready',
            `Plan cannot start executing from status "${status}"`,
          );
        if (task.steps.length === 0)
          throw new ApiError(409, 'plan_not_ready', 'The plan has no steps to execute');
        this.requireTasks().setPlanState(task.id, { status: 'executing' });
        session.enterExecution();
        await this.startExecution(task.id, `开始执行计划「${task.title}」。`);
        return session.view();
      }
      case 'resume': {
        if (task === undefined)
          throw new ApiError(409, 'plan_unavailable', 'No plan is active in this session');
        this.requireTasks().setPlanState(task.id, { status: 'executing' });
        session.enterExecution();
        await this.startExecution(task.id, `继续执行计划「${task.title}」。`);
        return session.view();
      }
      case 'pause': {
        if (task === undefined)
          throw new ApiError(409, 'plan_unavailable', 'No plan is active in this session');
        this.requireTasks().setPlanState(task.id, { status: 'paused' });
        // 暂停 = 停手：释放租约并让当前轮结束（由调用方 abort），不留「还在跑」的假象。
        this.executor?.stop(task.id);
        session.publish();
        return session.view();
      }
      case 'abandon': {
        if (task === undefined)
          throw new ApiError(409, 'plan_unavailable', 'No plan is active in this session');
        this.executor?.stop(task.id);
        this.requireTasks().abandonPlan(
          task.id,
          typeof message === 'string' && message.trim() ? message.trim() : '用户放弃计划',
        );
        session.exitPlan();
        return session.view();
      }
      default:
        throw new ApiError(
          422,
          'unsupported_command',
          `Unsupported plan action: ${String(action)}`,
        );
    }
  }

  /** 启动执行：优先走执行器（租约 + 绑定）；没有执行器时用会话自身的 prompt 通道。 */
  private async startExecution(taskId: string, prompt: string): Promise<void> {
    const executor = this.executor;
    if (executor === undefined)
      throw new ApiError(409, 'plan_unavailable', 'Plan execution is unavailable (no executor)');
    const task = await executor.start(taskId, prompt);
    this.refresh(task.sessionId ?? '');
  }

  /** 状态机登记（attach 时调用）。 */
  register(session: PlanSession): void {
    this.sessions.set(session.sessionId, session);
  }

  /** 状态视图更新转发给监听器（注册表把它转成 SSE `plan_updated`）。 */
  publishState(plan: PlanView): void {
    try {
      this.listener?.(plan);
    } catch (error) {
      this.options.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'plan publish failed',
      );
    }
  }

  dispose(): void {
    this.sessions.clear();
  }

  private requireSession(sessionId: string): PlanSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      throw new ApiError(
        409,
        'plan_unavailable',
        `Plan mode is unavailable for this session (not opened yet)`,
      );
    return session;
  }

  private requireTasks(): TaskService {
    const tasks = this.tasks;
    if (tasks === undefined)
      throw new ApiError(409, 'plan_unavailable', 'Plan mode requires the task service');
    return tasks;
  }

  /** 无活跃状态机时（会话未打开）从库里直接投影。 */
  private viewFromStore(sessionId: string): PlanView {
    const tasks = this.tasks;
    if (tasks === undefined) return emptyPlanView(sessionId);
    try {
      const task = tasks.activePlanForSession(sessionId);
      return task === undefined ? emptyPlanView(sessionId) : toPlanView(task);
    } catch {
      return emptyPlanView(sessionId);
    }
  }

  /** 会话状态机（测试与注册表用）。 */
  session(sessionId: string): PlanSession | undefined {
    return this.sessions.get(sessionId);
  }
}

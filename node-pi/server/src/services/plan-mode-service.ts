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
 * 3. **权限用能力集而非快照**：规划期按 `PlanPolicy` 分类放行（只读 + 验证类命令）。
 *    拦截点是 `tool_call`（`evaluateToolCall`）——**不再动 activeTools**。
 *
 * 关于「不再动 activeTools」（缓存稳定性，见 `docs/node-plan-cache-stability.md`）：
 * `tools` 数组与 system prompt 一起位于请求最前面，计划开始/结束时增删工具（以前的
 * 「加计划工具 / 关写工具 / 退出时收回」）会让整个前缀缓存当场失效。现在工具集在整个
 * 会话生命周期内恒定（由创建时的预设白名单决定），规划期只读完全由 `tool_call` 拦截兑现。
 * 代价是模型在规划期可能试一次写工具被拦，这是刻意选的：缓存失效比一次被拦的调用贵得多。
 *
 * 状态机的迁移条件全部来自用户动作（确认/暂停/放弃）、模型提议（`propose_plan` 的
 * 用户答复）或服务端校验（工具参数与证据），没有一条依赖模型「写了什么标记」。
 */

import type {
  AgentToolResult,
  ContextEvent,
  ExtensionAPI,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';

import { ApiError } from '../errors.js';
import type { ServiceLogger } from './service-logger.js';
import {
  derivePlanStatus,
  emptyPlanView,
  planTitleFromMessage,
  toPlanView,
  type PlanView,
} from './platform/plan-model.js';
import {
  buildPlanTools,
  buildProposePlanTool,
  PlanToolbox,
  type ProposePlanParams,
} from './plan-tools.js';
import type { QuestionOutcome, QuestionSpec } from './user-question.js';
import { DEFAULT_PLAN_POLICY, evaluatePlanBash, type PlanPolicy } from './plan-policy.js';
import { SUBAGENT_TOOL_NAME } from './subagent-tools.js';
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

/** 错误消息归一化：不把堆栈/原始对象塞给模型。 */
function messageOf(error: Error | unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `propose_plan` 的结果封装（与 plan-tools 的 textResult 同形，避免跨文件依赖实现细节）。 */
function planToolResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text }], details };
}

interface SessionContext {
  cwd?: string;
  sessionManager: {
    getSessionId(): string;
    getEntries(): unknown[];
  };
}

/**
 * 提问通道的最小接口（由 `QuestionBroker` 实现）。
 * 中文说明：只依赖 `ask()`，不把整个 broker 拉进依赖图，测试里给个假实现就能覆盖
 * 「用户同意 / 拒绝 / 不回答」三条分支。
 */
export interface PlanQuestionBroker {
  ask(input: {
    sessionId: string;
    toolCallId: string;
    questions: QuestionSpec[];
    signal?: AbortSignal;
  }): Promise<{ outcome: QuestionOutcome }>;
}

/** `propose_plan` 问题里「同意先规划」的选项文案（与工具实现共用）。 */
export const PROPOSE_PLAN_OPTION = '先规划';
const PROPOSE_PLAN_DECLINE_OPTION = '直接做';

/** 一个会话的计划状态机：持有当前计划，权限完全由 `tool_call` 拦截实现。 */
class PlanSession {
  private sessionIdValue = '';
  private cwd: string | undefined;
  private planTaskId: string | undefined;
  /** 最近一条用户消息（`propose_plan` 没用 goal 时的计划目标）。 */
  private lastPrompt = '';

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly service: PlanModeService,
    private readonly toolbox: PlanToolbox,
    private readonly tasks: TaskService,
  ) {}

  /**
   * 计划工具（工厂期注册）。
   * 中文说明：只在工厂期注册一次；**不在会话生命周期里动 activeTools**（缓存稳定性）。
   * `propose_plan` 需要提问通道与状态机，所以它的实现留在本类，文案在 `plan-tools.ts`。
   */
  registerTools(): void {
    for (const tool of buildPlanTools(this.toolbox)) this.pi.registerTool(tool);
    this.pi.registerTool(
      buildProposePlanTool((params, context) => this.proposePlan(params, context)),
    );
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
   * 开始规划（`mode: 'plan'` 的首条消息、`plan_start` 或 `propose_plan` 被用户接受）。
   * 已有未结束的计划时**采纳而不是新建**——用户多半想改计划，而不是丢掉它。
   */
  startPlanning(message: string): PlanView {
    const existing = this.current();
    if (existing !== undefined) {
      const status = derivePlanStatus(existing);
      if (status === 'paused' || status === 'proposed' || status === 'drafting') {
        // 回到草稿：允许 submit_plan 整体替换；已提出的澄清问题保留给模型参考。
        this.tasks.setPlanState(existing.id, { status: 'drafting' });
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
    this.appendRef(task);
    this.publish();
    return this.view();
  }

  /** 采纳/切换当前计划：绑定工具箱。 */
  bindPlan(task: TaskRecord | undefined): void {
    this.planTaskId = task?.id;
    this.toolbox.bind(task?.id);
  }

  /** 进入执行态：广播新状态（工具集不变，规划期的拦截自动失效）。 */
  enterExecution(): void {
    this.publish();
  }

  /** 计划结束（完成/放弃）：广播新状态。 */
  exitPlan(): void {
    this.publish();
  }

  /**
   * tool_call：规划期按能力集拦截。
   * 中文说明：这是规划期只读的**唯一约束点**。工具不再从 activeTools 里移除（缓存稳定性），
   * 所以「模型看得到 write/edit」是常态——能不能真的执行完全由这里决定，
   * 理由文本会作为工具错误回到模型，让它改用只读方式或等用户确认。
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
    // 子任务委派（M5）：规划期只放行**结构上只读**的预设。
    // 中文说明：子会话是独立会话，不受本策略约束（它的 planMode 是关的），
    // 所以不能「信任预设的自觉」——带 bash / 写工具的预设一律不放行。
    if (event.toolName === SUBAGENT_TOOL_NAME) {
      if (!policy.allowSubagentDelegation)
        return {
          block: true,
          reason:
            'Plan mode does not allow delegating to subagents. Confirm the plan first, then delegate while executing.',
        };
      const preset = (event.input as { preset?: unknown } | null | undefined)?.preset;
      if (typeof preset !== 'string' || !this.service.canDelegateTo(this.cwd ?? '', preset))
        return {
          block: true,
          reason:
            'Plan mode only allows delegating to read-only subagent presets (tools within read/grep/find/ls and no bash). Confirm the plan to delegate to writing agents.',
        };
    }
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

  /**
   * before_agent_start：把当前计划上下文注入为一条隐藏消息。
   * 中文说明（缓存）：内容与历史里最后一条同类型注入完全相同时**不重复注入**。
   * 旧实现每轮都注入一条新的、再由 `onContext` 把旧的全删掉，等价于从「第一次注入的位置」
   * 往后每轮都改写历史——前缀缓存从那里开始就全部失效（plan 越久越贵）。
   * 现在只在内容真的变了（状态跃迁、rev 变化）时才写，其余轮次历史一字不动。
   */
  beforeAgentStart(
    event?: { prompt?: string },
    ctx?: SessionContext,
  ): { message: { customType: string; content: string; display: boolean } } | undefined {
    if (typeof event?.prompt === 'string' && event.prompt.trim()) this.lastPrompt = event.prompt;
    const task = this.current();
    if (task === undefined) return undefined;
    const customType = this.isPlanning()
      ? PLANNING_CONTEXT_TYPE
      : this.isExecuting()
        ? EXECUTING_CONTEXT_TYPE
        : undefined;
    if (customType === undefined) return undefined;
    const content =
      customType === PLANNING_CONTEXT_TYPE
        ? buildPlanningContext(task, this.service.policy)
        : buildExecutingContext(task);
    if (this.lastInjectedContent(ctx, customType) === content) return undefined;
    return { message: { customType, content, display: false } };
  }

  /** 历史里最后一条同类注入的正文（用于去抖；拿不到历史时返回 undefined＝照旧注入）。 */
  private lastInjectedContent(
    ctx: SessionContext | undefined,
    customType: string,
  ): string | undefined {
    let entries: unknown[];
    try {
      entries = ctx?.sessionManager.getEntries() ?? [];
    } catch {
      return undefined;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as { type?: unknown; customType?: unknown; content?: unknown };
      if (entry?.type !== 'custom_message' || entry.customType !== customType) continue;
      return typeof entry.content === 'string' ? entry.content : undefined;
    }
    return undefined;
  }

  /**
   * `propose_plan`：问用户「要不要先进规划」，用户同意后才真的开启。
   * 中文说明：提议权交给模型、决定权留在用户——这是「模型自己判断要不要规划」与
   * 「只有用户能确认执行」之间的最小交叉点，不需要任何新的 SSE / 前端契约。
   */
  private async proposePlan(
    params: ProposePlanParams,
    context: { toolCallId: string; signal?: AbortSignal },
  ): Promise<AgentToolResult<unknown>> {
    const task = this.current();
    const status = this.status();
    if (task !== undefined && status !== 'completed' && status !== 'abandoned') {
      throw new Error(
        `当前会话已经有计划（状态 ${status}），不需要再提议：` +
          '直接用 submit_plan / update_plan / complete_step 推进它。',
      );
    }
    const goal = params.goal?.trim() || this.lastPrompt.trim() || '用户同意进入规划模式';
    const questions: QuestionSpec[] = [
      {
        id: 'plan-mode',
        question: `要不要先进入规划模式？（只读调研 → 出计划 → 你确认后再动手）：${goal}`,
        options: [PROPOSE_PLAN_OPTION, PROPOSE_PLAN_DECLINE_OPTION],
        ...(params.reason === undefined || !params.reason.trim()
          ? {}
          : { details: `理由：${params.reason.trim()}` }),
      },
    ];
    let outcome: QuestionOutcome;
    try {
      // 提问是通用通道：未接入（未注入 broker）时降级为「提议不了」，而不是把工具弄成错误。
      const broker = this.service.questionBroker;
      if (broker === undefined) {
        return planToolResult(
          '提问通道不可用，无法征求用户意见：请让用户手动开启规划模式（发送消息时选「先规划」），' +
            '在此之前直接按当前要求推进任务。',
          { status: 'unavailable', goal },
        );
      }
      outcome = (
        await broker.ask({
          sessionId: this.sessionId,
          toolCallId: context.toolCallId,
          questions,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
      ).outcome;
    } catch (error) {
      return planToolResult(
        `提议失败：${messageOf(error as Error)}。请直接完成任务或等用户手动开启。`,
        {
          status: 'unavailable',
          goal,
        },
      );
    }

    const agreed =
      outcome.answered &&
      (outcome.answers[0]?.selected ?? []).some((item) => item === PROPOSE_PLAN_OPTION);
    if (!agreed) {
      const why = outcome.answered
        ? '用户选择先直接做'
        : `用户没有回答（${outcome.reason}），按「不规划」处理`;
      return planToolResult(`${why}：继续直接完成任务，不要再调用计划工具，也不要反复提议。`, {
        status: 'declined',
        reason: outcome.reason,
        goal,
      });
    }

    const started = this.startPlanning(goal);
    const planTask = this.current();
    return planToolResult(
      '用户同意先规划：本轮已进入**只读规划期**。调研清楚后用 submit_plan 提交结构化计划。\n\n' +
        (planTask === undefined ? '' : buildPlanningContext(planTask, this.service.policy)),
      {
        status: 'accepted',
        planId: started.planId,
        taskId: started.taskId,
        goal,
      },
    );
  }

  /**
   * 状态变化后广播视图（服务层转成 SSE `plan_updated`）。
   * 中文说明：计划自然跑完（步骤全完成）、放弃、重启接管都走这里。工具集不再随状态变动，
   * 所以这里只做一件事：把最新视图推给前端。
   */
  publish(): void {
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

  /**
   * ——已删除：工具差集（缓存稳定性）——
   * 规划期「关掉写工具 + 加计划工具」、退出时「收回计划工具」曾用 `setActiveTools` 在这里实现。
   * 它确实让模型在规划期看不到写工具，但代价是**整段请求前缀（tools + system prompt）的
   * 缓存当场失效**——一次计划 2~4 次，远比「模型偶尔试一次被拦」贵。现在工具集恒定，
   * 规划期只读由 `evaluateToolCall` 兑现（见本类头部注释与 docs/node-plan-cache-stability.md）。
   */
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
  private questionBrokerValue: PlanQuestionBroker | undefined;
  /** 只读预设判定（M5，由子任务服务注入；未注入时规划期不放行委派）。 */
  private readOnlyAgent: ((cwd: string, preset: string) => boolean) | undefined;
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

  /**
   * 注入提问通道（`propose_plan` 用它征求用户是否进入规划模式）。
   * 中文说明：与 setTaskService / setExecutor 同一手法——只依赖 `PlanQuestionBroker`
   * 这个小接口，不把整个 broker 拉进依赖图；未注入时 `propose_plan` 会如实告知
   * 「提议不了，请用户手动开启」，不会把工具弄成错误。
   */
  setQuestionBroker(broker: PlanQuestionBroker): void {
    this.questionBrokerValue = broker;
  }

  /** 提问通道（未注入时为 undefined）。 */
  get questionBroker(): PlanQuestionBroker | undefined {
    return this.questionBrokerValue;
  }

  /**
   * 注入「只读预设」判定（M5）。
   * 中文说明：PlanModeService 只关心「这个预设能不能在规划期用」，而预设发现属于
   * SubagentService，所以用注入打破依赖（与 setTaskService / setExecutor 同一手法）。
   * 未注入时规划期一律不放行委派（宁严不宽）。
   */
  setReadOnlyAgentResolver(resolver: (cwd: string, preset: string) => boolean): void {
    this.readOnlyAgent = resolver;
  }

  /** 规划期能否把子任务委派给这个预设（未注入判定器时一律不能）。 */
  canDelegateTo(cwd: string, preset: string): boolean {
    return this.readOnlyAgent?.(cwd, preset) === true;
  }

  /** 生成「Web Plan 模式」内联扩展：每个会话一套钩子 + 5 个计划工具（含 propose_plan）。 */
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
      // 把 event（要拿 prompt 当计划目标）与 ctx（要读历史做注入去抖）都传进去。
      pi.on('before_agent_start', (event, ctx) =>
        session.beforeAgentStart(event, ctx as SessionContext),
      );
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

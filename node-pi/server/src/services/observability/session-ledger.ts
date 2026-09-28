/**
 * 会话事件 → runs/steps 的账本（M1 的唯一插桩点）。
 *
 * 中文说明：本类订阅不到任何东西，而是由 `AgentRegistry.publish()` 在事件发布后
 * 同步调用 `record()`。这样做的理由：
 * - **零主链路侵入**：不改 Agent 循环，只在已有的汇聚点后面加一行调用；
 * - **单向依赖**：账本不认识注册表（只收一个最小上下文），不会形成循环依赖。
 *
 * 铁律（硬约束）：`record()` 及其所有 note* 方法**必须永不抛错**。
 * 内部一律 try/catch + warn 降级，宁可丢一条 trace，也不能让 agent loop 挂掉。
 *
 * run 的边界＝`agent_settled`：SDK 的 `_runAgentPrompt()` 里 `agent_start` 会因重试/
 * 压缩后的续跑触发多次，只有 `agent_settled` 在所有自动重试与压缩队列收敛后才发一次
 * （见 dist/core/agent-session.js 的 `_runAgentPrompt` 与 `_emitAgentSettled`）。
 */

import { randomUUID } from 'node:crypto';
import type { AgentSessionEvent, InlineExtension } from '@earendil-works/pi-coding-agent';

import type { ServiceLogger } from '../service-logger.js';
import type { TraceRepository } from '../platform/trace-repository.js';
import type { BlockedBy, RunRow, StepKind, StepRow } from '../platform/trace-model.js';
import type { QuestionReason, QuestionTraceSink } from '../agent/user-question.js';
import { builtinCostUsd } from './model-cost.js';
import { buildObservabilityExtension, type RuntimeObserver } from './observability-extension.js';
import { collectInjections, promptShapeOf, type PromptShape } from './prompt-shape.js';
import { summarize, type ContentSummary } from './redact.js';

/** 记账所需的会话上下文（由注册表从 RegistryEntry 提取）。 */
export interface LedgerSessionContext {
  sessionId: string;
  cwd: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  /** 会话当前执行的任务（M2 关联）：会在 run 开始时写进 runs.task_id。 */
  taskId?: string;
  /** M5：本会话是子会话时，父会话当前那条 run 的 id（写进 runs.parent_run_id）。 */
  parentRunId?: string;
  parentSessionId?: string;
  subagentPreset?: string;
  subagentDepth?: number;
}

/**
 * 可被记账的事件。
 * 中文说明：前两类来自 SDK 事件流；后两类是本服务自己发布的合成事件
 * （见 AgentRegistry.announceApproval / announcePlan / announceTask），
 * 这里只需要能识别并忽略。
 */
export type LedgerEvent =
  | AgentSessionEvent
  | { type: 'agent_end'; error: string }
  | { type: 'plan_updated'; plan: unknown }
  | { type: 'task_updated'; task: unknown }
  | { type: 'task_recovery_required'; tasks: unknown[] }
  /** 向用户提问（M4.1）：M1 账本只把它当普通会话事件处理，不做额外统计。 */
  | { type: 'question_pending'; question: unknown }
  | { type: 'question_resolved'; questionId: string }
  | {
      type: 'tool_call_pending';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      reason: string;
      rule: string;
      risk: 'medium' | 'high' | 'critical';
      category: string;
    };

export interface LedgerOptions {
  /** 是否保留正文（PI_NODE_TRACE_CONTENT=1）。 */
  content?: boolean;
  /** 注入时间源（测试用）。 */
  now?: () => number;
  /** 注入 run id 生成器（测试用）。 */
  runIdFactory?: () => string;
}

/** 审批的最终决策（含超时与中止，都按「未放行」处理）。 */
export type ApprovalDecision = 'approved' | 'denied' | 'timed_out';

/** assistant 消息里我们要用到的字段（SDK 未导出 AssistantMessage 形状，按需声明）。 */
interface AssistantMessageMeta {
  role?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
}

/** 一个进行中的 run。 */
interface RunState {
  runId: string;
  sessionId: string;
  cwd: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  startedAt: number;
  turns: number;
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  ttftMs?: number;
  /** 人机等待累计（审批 + 提问）；收尾时与 durationMs 一起拆出 activeMs。 */
  waitMs: number;
  stopReason?: string;
  errorType?: string;
  errorMessage?: string;
  retries: number;
  /** 当前 llm_call 步骤（turn_start 开、message_end 关）。 */
  llm?: LlmStepState;
  /** provider HTTP 请求发出时刻（before_provider_headers）。 */
  providerStartedAt?: number;
  /** 上一次请求的形状（与本次比较，判断前缀缓存是否被打断）。 */
  lastPromptShape?: PromptShape;
  /** customType → 最近一次注入正文的指纹（去抖：内容没变就不重复记账）。 */
  injections: Map<string, string>;
  tools: Map<string, ToolStepState>;
  blocks: Map<string, { blockedBy: BlockedBy; reason?: string }>;
  approvals: Map<string, { startedAt: number; rule: string; risk: string; toolName: string }>;
  questions: Map<string, { startedAt: number; questionCount: number }>;
  compaction?: { startedAt: number; reason: string };
  /** run 运行期计数器（收尾时写进 runs.meta，为 0 的不落库）。 */
  counters: RunCounters;
  /** run 开始时写入的元信息（子会话的 preset/depth）：收尾时合并而不是覆盖。 */
  meta?: Record<string, unknown>;
}

/** 当前 llm_call 步骤的进行中状态。 */
interface LlmStepState {
  startedAt: number;
  httpStatus?: number;
  httpLatencyMs?: number;
  /** 本次请求的形状（`before_provider_request`）。 */
  promptShape?: PromptShape;
  /** 相对上一次请求，工具集（前缀缓存最敏感的部分）是否变化。 */
  toolsChanged?: boolean;
  /** 相对上一次请求，系统提示词是否变化。 */
  systemChanged?: boolean;
}

/** 一次工具调用的进行中状态。 */
interface ToolStepState {
  startedAt: number;
  toolName: string;
  args?: ContentSummary;
  /** 首次流式进度输出的耗时（`tool_execution_update`）——相当于工具的「首字节」。 */
  firstOutputMs?: number;
  /** 进度更新次数。 */
  updates: number;
}

/**
 * run 运行期计数器（P0）。
 * 中文说明：这些都是「事件来了顺手加一」的廉价信号，合并在收尾时写进 `runs.meta`，
 * 不需要为每一项加列；为 0 的项不写，避免 meta 里堆一堆 0。
 */
interface RunCounters {
  assistantMessages: number;
  userMessages: number;
  toolResults: number;
  agentEnds: number;
  retriesSucceeded: number;
  retriesFailed: number;
  summaryRetries: number;
  maxSteerQueue: number;
  maxFollowUpQueue: number;
  /** run 期间追加的会话条目数（会话 JSONL 的膨胀速度）。 */
  entries: number;
  /** 请求形状（工具集/系统提示词）发生变化的次数。 */
  promptShapeChanges: number;
  /** 上下文注入次数（去抖后）。 */
  contextInjections: number;
}

function emptyCounters(): RunCounters {
  return {
    assistantMessages: 0,
    userMessages: 0,
    toolResults: 0,
    agentEnds: 0,
    retriesSucceeded: 0,
    retriesFailed: 0,
    summaryRetries: 0,
    maxSteerQueue: 0,
    maxFollowUpQueue: 0,
    entries: 0,
    promptShapeChanges: 0,
    contextInjections: 0,
  };
}

/** 已知的策略阻断文案（无法从事件本身区分拦截与失败时的兜底识别）。 */
const BLOCK_REASON_MARKERS = ['Tool execution was not approved', 'Plan mode is read-only'];

/** 记住多少个会话的最近 run id（防无界增长；远超实际并发会话数）。 */
const MAX_LAST_RUN_IDS = 500;

/**
 * 收尾时写入的 meta = 开始时的 meta + 收尾才知道的信息（重试次数、运行期计数）。
 * 中文说明：必须合并，否则 `{ retries }` 会把子会话的 preset/depth 覆盖掉。
 */
function finishMeta(state: RunState): Record<string, unknown> | undefined {
  const counters = countersMeta(state.counters);
  const extra: Record<string, unknown> = {
    ...(state.retries > 0 ? { retries: state.retries } : {}),
    ...(counters ?? {}),
  };
  if (state.meta === undefined) return Object.keys(extra).length === 0 ? undefined : extra;
  return { ...state.meta, ...extra };
}

/** 运行期计数器 → meta（为 0 的不写，键名固定便于查询）。 */
function countersMeta(counters: RunCounters): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counters)) {
    if (value > 0) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 子会话的 run 在 meta 里带上预设与深度：执行树能看出「这是谁派出来的、第几层」。 */
function subagentMeta(context: LedgerSessionContext): Record<string, unknown> | undefined {
  if (context.parentSessionId === undefined && context.subagentPreset === undefined)
    return undefined;
  return {
    ...(context.parentSessionId === undefined ? {} : { parentSessionId: context.parentSessionId }),
    ...(context.subagentPreset === undefined ? {} : { preset: context.subagentPreset }),
    ...(context.subagentDepth === undefined ? {} : { depth: context.subagentDepth }),
  };
}

/**
 * 会话账本：把一个会话的事件流沉淀成 runs / steps。
 * 中文说明：同时对 `ProviderObserver` 契约负责（provider 层 HTTP 观测）。
 */
export class SessionLedger implements RuntimeObserver, QuestionTraceSink {
  private readonly runs = new Map<string, RunState>();
  /** 会话 → 最近一次 run id（run 结束后仍保留，供子任务回报 runId 用）。 */
  private readonly lastRunIds = new Map<string, string>();

  /** 会话当前正在进行的 run id（父会话委派子任务时要把它写进 parent_run_id）。 */
  currentRunId(sessionId: string): string | undefined {
    return this.runs.get(sessionId)?.runId;
  }

  /** 会话最近一次 run id（已结束也保留）——子任务结束后回报给自己那条 run。 */
  lastRunId(sessionId: string): string | undefined {
    return this.lastRunIds.get(sessionId) ?? this.runs.get(sessionId)?.runId;
  }

  constructor(
    private readonly repository: TraceRepository,
    private readonly logger?: ServiceLogger,
    private readonly options: LedgerOptions = {},
  ) {}

  /** 事件入口：AgentRegistry.publish() 的唯一插桩点。 */
  record(context: LedgerSessionContext, event: LedgerEvent): void {
    this.guard('record', () => this.handle(context, event));
  }

  /** 审批挂起（ToolApprovalBroker.onPending）。 */
  noteApprovalStart(pending: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    rule: string;
    risk: string;
  }): void {
    this.guard('approval_start', () => {
      const state = this.runs.get(pending.sessionId);
      if (!state) return;
      state.approvals.set(pending.toolCallId, {
        startedAt: this.now(),
        rule: pending.rule,
        risk: pending.risk,
        toolName: pending.toolName,
      });
    });
  }

  /** 审批结算：落一条 approval 步骤；未放行时把该 tool_call 标记为策略阻断。 */
  noteApprovalDecision(input: {
    sessionId: string;
    toolCallId: string;
    decision: ApprovalDecision;
    decidedBy: string;
  }): void {
    this.guard('approval_decision', () => {
      const state = this.runs.get(input.sessionId);
      if (!state) return;
      const pending = state.approvals.get(input.toolCallId);
      state.approvals.delete(input.toolCallId);
      const endedAt = this.now();
      const startedAt = pending?.startedAt ?? endedAt;
      const waitMs = Math.max(0, endedAt - startedAt);
      // 等真人的时间计入 run 的人机等待（与 activeMs 拆分）。
      state.waitMs += waitMs;
      const rule = pending?.rule ?? 'unknown';
      const risk = pending?.risk ?? 'unknown';
      this.repository.addStep({
        runId: state.runId,
        sessionId: state.sessionId,
        turnIndex: state.turnIndex,
        kind: 'approval',
        toolName: pending?.toolName,
        toolCallId: input.toolCallId,
        startedAt,
        endedAt,
        durationMs: waitMs,
        isError: input.decision !== 'approved',
        approvalRule: rule,
        approvalRisk: risk,
        approvalDecision: input.decision,
        approvalWaitMs: waitMs,
        decidedBy: input.decidedBy,
        meta: pending ? undefined : { unmatched: true },
      });
      if (input.decision !== 'approved') {
        state.blocks.set(input.toolCallId, {
          blockedBy: 'approval',
          reason: `approval ${input.decision}`,
        });
      }
    });
  }

  /** 记录一次策略阻断（审批拒绝、规划期只读等），供 tool_execution_end 归类。 */
  noteToolBlock(input: {
    sessionId: string;
    toolCallId: string;
    blockedBy: BlockedBy;
    reason?: string;
  }): void {
    this.guard('tool_block', () => {
      const state = this.runs.get(input.sessionId);
      if (!state) return;
      // 审批路径已经登记过更强的归因（approval），不要被后来的泛化原因覆盖。
      if (state.blocks.has(input.toolCallId)) return;
      state.blocks.set(input.toolCallId, { blockedBy: input.blockedBy, reason: input.reason });
    });
  }

  /**
   * 提问挂起（`QuestionBroker` 的 QuestionTraceSink）。
   * 中文说明：与审批对称——两条人机通道都必须计「等了多久」，否则 run 耗时里会
   * 混进用户读上下文、想答案的时间（提问超时默认 10 分钟，污染得很厉害）。
   */
  noteQuestionStart(input: {
    sessionId: string;
    questionId: string;
    toolCallId: string;
    questionCount: number;
  }): void {
    this.guard('question_start', () => {
      const state = this.runs.get(input.sessionId);
      if (!state) return;
      state.questions.set(input.questionId, {
        startedAt: this.now(),
        questionCount: input.questionCount,
      });
    });
  }

  /** 提问结算：落一条 `question` 步骤，并把等待时长计入 run 的人机等待。 */
  noteQuestionDecision(input: {
    sessionId: string;
    questionId: string;
    reason: QuestionReason;
    answers?: number;
  }): void {
    this.guard('question_decision', () => {
      const state = this.runs.get(input.sessionId);
      if (!state) return;
      const pending = state.questions.get(input.questionId);
      state.questions.delete(input.questionId);
      const endedAt = this.now();
      const startedAt = pending?.startedAt ?? endedAt;
      const waitMs = Math.max(0, endedAt - startedAt);
      state.waitMs += waitMs;
      this.repository.addStep({
        runId: state.runId,
        sessionId: state.sessionId,
        turnIndex: state.turnIndex,
        kind: 'question',
        startedAt,
        endedAt,
        durationMs: waitMs,
        // 「未被回答」不是错误（超时/中止都有确定归宿），只有异常原因才算失败。
        isError: false,
        meta: {
          reason: input.reason,
          questions: pending?.questionCount ?? 0,
          answers: input.answers ?? 0,
          ...(pending === undefined ? { unmatched: true } : {}),
        },
      });
    });
  }

  /** 命令级失败（prompt() 直接 reject，例如模型校验失败）：无 run 时补一条失败 run。 */
  noteCommandFailure(context: LedgerSessionContext, error: unknown): void {
    this.guard('command_failure', () => {
      if (this.runs.has(context.sessionId)) return; // 已有 run 在跑：失败属于该 run 内部
      const state = this.createRun(context);
      state.errorType = 'command_error';
      state.errorMessage = messageOf(error);
      this.finishRun(state, 'error');
    });
  }

  /** 会话关闭/删除：把未结算的 run 收尾，避免留下永远 running 的记录。 */
  finalizeSession(
    sessionId: string,
    status: Exclude<RunRow['status'], 'running'> = 'aborted',
  ): void {
    this.guard('finalize_session', () => {
      const state = this.runs.get(sessionId);
      if (!state) return;
      this.closeLlmStep(state, { incomplete: true });
      this.finishRun(state, status);
    });
  }

  // ---- 运行期观测（RuntimeObserver） ----

  noteProviderRequestStart(sessionId: string): void {
    this.guard('provider_request', () => {
      const state = this.runs.get(sessionId);
      if (state) state.providerStartedAt = this.now();
    });
  }

  noteProviderResponse(sessionId: string, status: number): void {
    this.guard('provider_response', () => {
      const state = this.runs.get(sessionId);
      if (!state || !state.llm) return;
      state.llm.httpStatus = status;
      if (state.providerStartedAt !== undefined) {
        state.llm.httpLatencyMs = Math.max(0, this.now() - state.providerStartedAt);
      }
      state.providerStartedAt = undefined;
    });
  }

  /**
   * 本次请求的载荷 → 请求形状（`before_provider_request`）。
   * 中文说明：工具集与系统提示词是前缀缓存的命门：任何一次「工具增删 / 系统提示词改写」
   * 都会让 provider 缓存从那里开始失效（见 docs/node-plan-cache-stability.md），
   * 所以这里把「变化过」这件事记在本次 llm_call 步骤上，并计数到 run.meta。
   */
  noteProviderPayload(sessionId: string, payload: unknown): void {
    this.guard('provider_payload', () => {
      const state = this.runs.get(sessionId);
      if (!state || !state.llm) return;
      const shape = promptShapeOf(payload);
      if (shape === undefined) return;
      const previous = state.lastPromptShape;
      state.llm.promptShape = shape;
      state.llm.toolsChanged =
        previous !== undefined && previous.toolsFingerprint !== shape.toolsFingerprint;
      state.llm.systemChanged =
        previous !== undefined && previous.systemDigest !== shape.systemDigest;
      if (state.llm.toolsChanged) state.counters.promptShapeChanges += 1;
      state.lastPromptShape = shape;
    });
  }

  /**
   * 每次调用前的消息数组 → 上下文注入审计（`context` 钩子）。
   * 中文说明：plan 状态、`[TASK RESUME]` 都是以隐藏自定义消息注入的（`display: false`），
   * 在会话里看不见、在 prompt 里占位，以前完全无法观测。按正文指纹去抖：同一条注入
   * 会随历史一直存在，内容没变就不重复记账。
   */
  noteContextMessages(sessionId: string, messages: unknown): void {
    this.guard('context_messages', () => {
      const state = this.runs.get(sessionId);
      if (!state) return;
      for (const injection of collectInjections(messages)) {
        if (state.injections.get(injection.customType) === injection.digest) continue;
        state.injections.set(injection.customType, injection.digest);
        state.counters.contextInjections += 1;
        const now = this.now();
        this.repository.addStep({
          runId: state.runId,
          sessionId: state.sessionId,
          turnIndex: state.turnIndex,
          kind: 'context_injection',
          startedAt: now,
          endedAt: now,
          durationMs: 0,
          isError: false,
          meta: {
            customType: injection.customType,
            chars: injection.chars,
            digest: injection.digest,
          },
        });
      }
    });
  }

  /** run 中途切模型（`model_select`）：记一条 `config_change`，run 行本身的归属不变。 */
  noteModelSelect(input: {
    sessionId: string;
    model?: string;
    previousModel?: string;
    source: string;
  }): void {
    this.guard('model_select', () => {
      const state = this.runs.get(input.sessionId);
      // 没有进行中的 run 就跳过：`restore`/启动时的选择不属于任何一次用户请求。
      if (!state) return;
      this.recordConfigChange(state, {
        field: 'model',
        from: input.previousModel,
        to: input.model,
        source: input.source,
      });
      // 后续轮次确实用了新模型：让「按调用归属」的账保持真实（run 行仍是开始时的模型）。
      if (input.model !== undefined) state.model = input.model;
    });
  }

  /** provider 层观测扩展（交给 OriginalPiSessionFactory 注入每个会话）。 */
  buildExtension(): InlineExtension {
    return buildObservabilityExtension(this);
  }

  flush(): void {
    this.repository.flush();
  }

  stats(): ReturnType<TraceRepository['stats']> {
    return this.repository.stats();
  }

  // ---- 事件分发 ----

  private handle(context: LedgerSessionContext, event: LedgerEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.createRunIfAbsent(context);
        break;
      case 'agent_settled':
        this.finalizeSession(context.sessionId, this.statusOf(this.runs.get(context.sessionId)));
        break;
      case 'turn_start':
        this.onTurnStart(context);
        break;
      case 'message_start':
        this.onMessageStart(context, event.message);
        break;
      case 'message_update':
        this.onMessageUpdate(context, event.message as AssistantMessageMeta);
        break;
      case 'message_end':
        this.onMessageEnd(context, event.message as AssistantMessageMeta);
        break;
      case 'turn_end':
        this.onTurnEnd(context, event as { toolResults?: unknown[] });
        break;
      case 'tool_execution_start':
        this.onToolStart(context, event.toolCallId, event.toolName, event.args);
        break;
      case 'tool_execution_update':
        this.onToolUpdate(context, event.toolCallId);
        break;
      case 'tool_execution_end':
        this.onToolEnd(context, event.toolCallId, event.toolName, event.result, event.isError);
        break;
      case 'compaction_start':
        this.onCompactionStart(context, event.reason);
        break;
      case 'compaction_end':
        this.onCompactionEnd(context, event);
        break;
      case 'auto_retry_start':
        this.onRetry(context);
        break;
      case 'auto_retry_end':
        this.onRetryEnd(context, event as { success?: boolean });
        break;
      case 'summarization_retry_scheduled':
        this.onSummarizationRetry(context);
        break;
      case 'queue_update':
        this.onQueueUpdate(
          context,
          event as { steering?: readonly string[]; followUp?: readonly string[] },
        );
        break;
      case 'entry_appended':
        this.onEntryAppended(context);
        break;
      case 'thinking_level_changed':
        this.onThinkingLevelChanged(context, event);
        break;
      case 'agent_end':
        this.onAgentEnd(context);
        break;
      default:
        break;
    }
  }

  private onTurnStart(context: LedgerSessionContext): void {
    const state = this.runs.get(context.sessionId) ?? this.createRun(context);
    // 上一轮的 llm 步骤没有正常闭合（例如中途 abort）：先收尾，避免丢步。
    if (state.llm) this.closeLlmStep(state, { incomplete: true });
    state.turns += 1;
    state.turnIndex = state.turns;
    state.llm = { startedAt: this.now() };
  }

  private onMessageUpdate(context: LedgerSessionContext, message: AssistantMessageMeta): void {
    if (message?.role !== 'assistant') return;
    const state = this.runs.get(context.sessionId);
    // TTFT＝本轮请求发出到首个流式增量；现有代码从未统计过，是 M1 最有价值的指标。
    if (!state || !state.llm || state.ttftMs !== undefined) return;
    state.ttftMs = Math.max(0, this.now() - state.llm.startedAt);
  }

  /**
   * 消息开始：只管计数（用户/助手各多少条）。
   * 中文说明：一次 run 里「1 条用户消息 vs 20 条 steer 消息」是很不同的形态，
   * 而 `runs.turns` 只反映模型轮次。这里只加计数，不做任何调度判断。
   */
  private onMessageStart(context: LedgerSessionContext, message: unknown): void {
    const role = (message as { role?: unknown } | null)?.role;
    if (role !== 'assistant' && role !== 'user') return;
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    if (role === 'assistant') state.counters.assistantMessages += 1;
    else state.counters.userMessages += 1;
  }

  private onMessageEnd(context: LedgerSessionContext, message: AssistantMessageMeta): void {
    if (message?.role !== 'assistant') return;
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    state.stopReason = message.stopReason ?? state.stopReason;
    if (message.stopReason === 'error') {
      state.errorType = 'model_error';
      state.errorMessage = message.errorMessage ?? 'model response failed';
    }
    this.closeLlmStep(state, { incomplete: false, message });
    const usage = message.usage;
    if (usage) {
      state.inputTokens += usage.input ?? 0;
      state.outputTokens += usage.output ?? 0;
      state.cacheReadTokens += usage.cacheRead ?? 0;
      state.cacheWriteTokens += usage.cacheWrite ?? 0;
      const reported = usage.cost?.total ?? 0;
      // models.json 覆盖内置模型会把 cost 归零，这时用内置目录价格兜底（显式非零价优先）。
      state.costUsd +=
        reported > 0
          ? reported
          : (builtinCostUsd(
              message.provider ?? state.provider,
              message.model ?? state.model,
              usage,
            ) ?? 0);
    }
  }

  /**
   * 轮次结束：只记「本轮产生了多少条工具结果」。
   * 中文说明：模型的「空转」表现为连续多轮不带工具结果，`turns` 看不出来，
   * 把 toolResults 累计到 run.meta 后能与 turns 对比着看。
   */
  private onTurnEnd(context: LedgerSessionContext, event: { toolResults?: unknown[] }): void {
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    state.counters.toolResults += Array.isArray(event.toolResults) ? event.toolResults.length : 0;
  }

  private onToolStart(
    context: LedgerSessionContext,
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): void {
    const state = this.runs.get(context.sessionId) ?? this.createRun(context);
    state.tools.set(toolCallId, {
      startedAt: this.now(),
      toolName,
      updates: 0,
      args: summarize(args, { content: this.options.content }),
    });
  }

  /**
   * 工具流式进度：记首次输出耗时（工具的「首字节」）。
   * 中文说明：一条跑 30 秒的 bash 与一条卡住 30 秒才出错的 bash 在总耗时上无法区分；
   * `firstOutputMs` 把「启动慢」与「执行慢」分开，与 LLM 的 TTFT 对称。
   * 这个事件在长命令上会高频触发，所以除了第一次之外只累加计数（不做任何字符串处理）。
   */
  private onToolUpdate(context: LedgerSessionContext, toolCallId: string): void {
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    const tool = state.tools.get(toolCallId);
    if (!tool) return;
    tool.updates += 1;
    if (tool.firstOutputMs === undefined) {
      tool.firstOutputMs = Math.max(0, this.now() - tool.startedAt);
    }
  }

  private onToolEnd(
    context: LedgerSessionContext,
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ): void {
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    const started = state.tools.get(toolCallId);
    state.tools.delete(toolCallId);
    const endedAt = this.now();
    const startedAt = started?.startedAt ?? endedAt;
    const resultSummary = summarize(result, { content: this.options.content });
    // 归因顺序：账本已登记的阻断 > 结果文案兜底识别 > 真实失败。
    const note = state.blocks.get(toolCallId);
    state.blocks.delete(toolCallId);
    const blockedBy = note?.blockedBy ?? (isError ? this.classifyBlock(resultSummary) : undefined);
    this.repository.addStep({
      runId: state.runId,
      sessionId: state.sessionId,
      turnIndex: state.turnIndex,
      kind: 'tool_call',
      toolName,
      toolCallId,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      isError,
      ...(blockedBy === undefined ? {} : { blockedBy }),
      ...(isError && blockedBy === undefined
        ? { errorType: 'tool_error', errorMessage: resultSummary.preview }
        : {}),
      ...(started?.args === undefined
        ? {}
        : {
            argsDigest: started.args.digest,
            argsBytes: started.args.bytes,
          }),
      resultDigest: resultSummary.digest,
      resultBytes: resultSummary.bytes,
      meta: {
        ...(started?.args?.preview ? { argsPreview: started.args.preview } : {}),
        ...(resultSummary.preview ? { resultPreview: resultSummary.preview } : {}),
        ...(started?.args?.text ? { argsText: started.args.text } : {}),
        ...(resultSummary.text ? { resultText: resultSummary.text } : {}),
        ...(note?.reason ? { blockedReason: note.reason } : {}),
        ...(started?.firstOutputMs === undefined
          ? {}
          : { firstOutputMs: started.firstOutputMs, progressUpdates: started.updates }),
      },
    });
  }

  private onCompactionStart(context: LedgerSessionContext, reason: string): void {
    const state = this.runs.get(context.sessionId) ?? this.createRun(context);
    state.compaction = { startedAt: this.now(), reason };
  }

  private onCompactionEnd(
    context: LedgerSessionContext,
    event: { reason: string; aborted?: boolean; errorMessage?: string },
  ): void {
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    const started = state.compaction;
    state.compaction = undefined;
    const endedAt = this.now();
    const startedAt = started?.startedAt ?? endedAt;
    this.repository.addStep({
      runId: state.runId,
      sessionId: state.sessionId,
      turnIndex: state.turnIndex,
      kind: 'compaction',
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      isError: Boolean(event.errorMessage),
      ...(event.errorMessage
        ? { errorType: 'compaction_error', errorMessage: event.errorMessage }
        : {}),
      meta: { reason: event.reason, aborted: event.aborted === true },
    });
  }

  private onRetry(context: LedgerSessionContext): void {
    const state = this.runs.get(context.sessionId);
    if (state) state.retries += 1;
  }

  /** 自动重试结束：终于能回答「重试有没有救回来」。 */
  private onRetryEnd(context: LedgerSessionContext, event: { success?: boolean }): void {
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    if (event.success === true) state.counters.retriesSucceeded += 1;
    else state.counters.retriesFailed += 1;
  }

  /** 摘要（压缩/分支摘要）重试：长会话崩溃的主要来源，以前完全不可见。 */
  private onSummarizationRetry(context: LedgerSessionContext): void {
    const state = this.runs.get(context.sessionId);
    if (state) state.counters.summaryRetries += 1;
  }

  /** 排队深度：用户 steer（打断当前走向）与 followUp 的最大堆积量。 */
  private onQueueUpdate(
    context: LedgerSessionContext,
    event: { steering?: readonly string[]; followUp?: readonly string[] },
  ): void {
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    const steer = event.steering?.length ?? 0;
    const followUp = event.followUp?.length ?? 0;
    if (steer > state.counters.maxSteerQueue) state.counters.maxSteerQueue = steer;
    if (followUp > state.counters.maxFollowUpQueue) state.counters.maxFollowUpQueue = followUp;
  }

  /** 会话条目落盘：run 期间追加了多少条（JSONL 膨胀速度）。 */
  private onEntryAppended(context: LedgerSessionContext): void {
    const state = this.runs.get(context.sessionId);
    if (state) state.counters.entries += 1;
  }

  /** run 中途改思考级别：与 `model_select` 同一条 `config_change` 路径。 */
  private onThinkingLevelChanged(
    context: LedgerSessionContext,
    event: { level?: unknown; previousLevel?: unknown },
  ): void {
    const state = this.runs.get(context.sessionId);
    if (!state) return;
    const to = typeof event.level === 'string' ? event.level : undefined;
    const from = typeof event.previousLevel === 'string' ? event.previousLevel : undefined;
    this.recordConfigChange(state, { field: 'thinkingLevel', from, to, source: 'set' });
    if (to !== undefined) state.thinkingLevel = to;
  }

  /**
   * agent loop 结束（非终态：后面可能还有重试/压缩后的续跑）。
   * 中文说明：run 的边界仍然是 `agent_settled`；这里只计数，用于交叉核对「一次 run 里
   * 到底跑了几次 agent loop」——多次说明发生了自动恢复，是排障线索。
   */
  private onAgentEnd(context: LedgerSessionContext): void {
    const state = this.runs.get(context.sessionId);
    if (state) state.counters.agentEnds += 1;
  }

  /** 记录一次配置变更（模型/思考级别）：只在有进行中 run 时执行。 */
  private recordConfigChange(
    state: RunState,
    change: { field: string; from?: string; to?: string; source: string },
  ): void {
    if (change.from === change.to) return;
    const now = this.now();
    this.repository.addStep({
      runId: state.runId,
      sessionId: state.sessionId,
      turnIndex: state.turnIndex,
      kind: 'config_change' as StepKind,
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      isError: false,
      meta: {
        field: change.field,
        ...(change.from === undefined ? {} : { from: change.from }),
        ...(change.to === undefined ? {} : { to: change.to }),
        source: change.source,
      },
    });
  }

  // ---- run 生命周期 ----

  private createRunIfAbsent(context: LedgerSessionContext): void {
    if (this.runs.has(context.sessionId)) return; // 重试/压缩续跑：仍属于同一个 run
    this.createRun(context);
  }

  private createRun(context: LedgerSessionContext): RunState {
    const startedAt = this.now();
    const meta = subagentMeta(context);
    const run: RunRow = {
      id: this.options.runIdFactory?.() ?? randomUUID(),
      sessionId: context.sessionId,
      cwd: context.cwd,
      ...(context.parentRunId === undefined ? {} : { parentRunId: context.parentRunId }),
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      provider: context.provider,
      model: context.model,
      thinkingLevel: context.thinkingLevel,
      startedAt,
      status: 'running',
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      ...(meta === undefined ? {} : { meta }),
    };
    this.repository.startRun(run);
    // 记住本会话最近一次 run：子任务结束后工具结果要回报 runId（trace 树的入口）。
    this.lastRunIds.set(context.sessionId, run.id);
    if (this.lastRunIds.size > MAX_LAST_RUN_IDS) {
      const oldest = this.lastRunIds.keys().next().value;
      if (oldest !== undefined) this.lastRunIds.delete(oldest);
    }
    const state: RunState = {
      runId: run.id,
      sessionId: context.sessionId,
      ...(meta === undefined ? {} : { meta }),
      cwd: context.cwd,
      provider: context.provider,
      model: context.model,
      thinkingLevel: context.thinkingLevel,
      startedAt,
      turns: 0,
      turnIndex: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      waitMs: 0,
      retries: 0,
      injections: new Map(),
      tools: new Map(),
      blocks: new Map(),
      approvals: new Map(),
      questions: new Map(),
      counters: emptyCounters(),
    };
    this.runs.set(context.sessionId, state);
    return state;
  }

  /** 结算并移除一个 run（重复调用是安全的：状态已移除即不再写）。 */
  private finishRun(state: RunState, status: RunRow['status']): void {
    const endedAt = this.now();
    const durationMs = Math.max(0, endedAt - state.startedAt);
    const waitMs = Math.min(state.waitMs, durationMs);
    this.repository.finishRun(state.runId, {
      endedAt,
      status,
      turns: state.turns,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheWriteTokens: state.cacheWriteTokens,
      costUsd: state.costUsd,
      ...(state.ttftMs === undefined ? {} : { ttftMs: state.ttftMs }),
      durationMs,
      // 人机等待与机器耗时分开记：p95 不该被「等人点确认」的时间污染。
      waitMs,
      activeMs: Math.max(0, durationMs - waitMs),
      ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
      ...(state.errorType === undefined ? {} : { errorType: state.errorType }),
      ...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage }),
      ...(finishMeta(state) === undefined ? {} : { meta: finishMeta(state) }),
    });
    this.runs.delete(state.sessionId);
  }

  /** 关闭当前 llm_call 步骤（正常结束或中途收尾）。 */
  private closeLlmStep(
    state: RunState,
    detail: { incomplete: boolean; message?: AssistantMessageMeta },
  ): void {
    const llm = state.llm;
    if (!llm) return;
    state.llm = undefined;
    state.providerStartedAt = undefined;
    const endedAt = this.now();
    const message = detail.message;
    const step: StepRow = {
      runId: state.runId,
      sessionId: state.sessionId,
      turnIndex: state.turnIndex,
      kind: 'llm_call',
      startedAt: llm.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - llm.startedAt),
      isError: message?.stopReason === 'error',
      ...(message?.stopReason === 'error'
        ? {
            errorType: 'model_error',
            errorMessage: message.errorMessage ?? 'model response failed',
          }
        : {}),
      meta: {
        provider: message?.provider ?? state.provider,
        model: message?.model ?? state.model,
        stopReason: message?.stopReason,
        incomplete: detail.incomplete,
        httpStatus: llm.httpStatus,
        httpLatencyMs: llm.httpLatencyMs,
        ...(cacheHitRateOf(message?.usage) === undefined
          ? {}
          : { cacheHitRate: cacheHitRateOf(message?.usage) }),
        ...(llm.promptShape === undefined
          ? {}
          : {
              promptMessages: llm.promptShape.messages,
              promptTools: llm.promptShape.tools.length,
              promptToolNames: llm.promptShape.tools,
              promptSystemChars: llm.promptShape.systemChars,
              toolsChanged: llm.toolsChanged === true,
              systemChanged: llm.systemChanged === true,
            }),
      },
    };
    this.repository.addStep(step);
  }

  private statusOf(state: RunState | undefined): Exclude<RunRow['status'], 'running'> {
    if (!state) return 'completed';
    if (state.errorType !== undefined) return 'error';
    if (state.stopReason === 'aborted') return 'aborted';
    return 'completed';
  }

  /** 结果文案兜底识别：命中已知阻断文案时归因为策略阻断。 */
  private classifyBlock(summary: ContentSummary): BlockedBy | undefined {
    const text = summary.text ?? summary.preview;
    return BLOCK_REASON_MARKERS.some((marker) => text.includes(marker)) ? 'policy' : undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** 所有入口的统一保护：异常只降级为 warn，绝不冒泡到 agent loop。 */
  private guard(action: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.logger?.warn(
        { action, error: error instanceof Error ? error.message : String(error) },
        'trace record skipped',
      );
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 本次调用的缓存命中率 = cacheRead /（input + cacheRead）。
 * 中文说明：与面板口径一致——provider 报的 `input` 已扣掉命中部分，所以分母是
 * 「真实发出去的提示词总量」。取不到用量时返回 undefined（不写这个键）。
 */
function cacheHitRateOf(usage: AssistantMessageMeta['usage']): number | undefined {
  if (usage === undefined) return undefined;
  const read = usage.cacheRead ?? 0;
  const prompt = (usage.input ?? 0) + read;
  if (prompt === 0) return undefined;
  return Math.round((read / prompt) * 10_000) / 10_000;
}

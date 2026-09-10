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
import type { BlockedBy, RunRow, StepRow } from '../platform/trace-model.js';
import { buildObservabilityExtension, type ProviderObserver } from './observability-extension.js';
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
  stopReason?: string;
  errorType?: string;
  errorMessage?: string;
  retries: number;
  /** 当前 llm_call 步骤（turn_start 开、message_end 关）。 */
  llm?: { startedAt: number; httpStatus?: number; httpLatencyMs?: number };
  /** provider HTTP 请求发出时刻（before_provider_headers）。 */
  providerStartedAt?: number;
  tools: Map<string, { startedAt: number; toolName: string; args?: ContentSummary }>;
  blocks: Map<string, { blockedBy: BlockedBy; reason?: string }>;
  approvals: Map<string, { startedAt: number; rule: string; risk: string; toolName: string }>;
  compaction?: { startedAt: number; reason: string };
}

/** 已知的策略阻断文案（无法从事件本身区分拦截与失败时的兜底识别）。 */
const BLOCK_REASON_MARKERS = ['Tool execution was not approved', 'Plan mode is read-only'];

/**
 * 会话账本：把一个会话的事件流沉淀成 runs / steps。
 * 中文说明：同时对 `ProviderObserver` 契约负责（provider 层 HTTP 观测）。
 */
export class SessionLedger implements ProviderObserver {
  private readonly runs = new Map<string, RunState>();

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

  // ---- ProviderObserver ----

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
      case 'message_update':
        this.onMessageUpdate(context, event.message as AssistantMessageMeta);
        break;
      case 'message_end':
        this.onMessageEnd(context, event.message as AssistantMessageMeta);
        break;
      case 'tool_execution_start':
        this.onToolStart(context, event.toolCallId, event.toolName, event.args);
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
      state.costUsd += usage.cost?.total ?? 0;
    }
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
      args: summarize(args, { content: this.options.content }),
    });
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

  // ---- run 生命周期 ----

  private createRunIfAbsent(context: LedgerSessionContext): void {
    if (this.runs.has(context.sessionId)) return; // 重试/压缩续跑：仍属于同一个 run
    this.createRun(context);
  }

  private createRun(context: LedgerSessionContext): RunState {
    const startedAt = this.now();
    const run: RunRow = {
      id: this.options.runIdFactory?.() ?? randomUUID(),
      sessionId: context.sessionId,
      cwd: context.cwd,
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
    };
    this.repository.startRun(run);
    const state: RunState = {
      runId: run.id,
      sessionId: context.sessionId,
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
      retries: 0,
      tools: new Map(),
      blocks: new Map(),
      approvals: new Map(),
    };
    this.runs.set(context.sessionId, state);
    return state;
  }

  /** 结算并移除一个 run（重复调用是安全的：状态已移除即不再写）。 */
  private finishRun(state: RunState, status: RunRow['status']): void {
    const endedAt = this.now();
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
      durationMs: Math.max(0, endedAt - state.startedAt),
      ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
      ...(state.errorType === undefined ? {} : { errorType: state.errorType }),
      ...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage }),
      ...(state.retries > 0 ? { meta: { retries: state.retries } } : {}),
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

/**
 * SubagentService：把「一次委派」做成**一个真正的子会话**（M5）。
 *
 * 中文说明：与官方 `subagent` 文件扩展的差别不是「能不能跑」，而是**跑得有没有痕迹**。
 * 官方扩展 spawn 一个独立 `pi` 进程（`--mode json --no-session`），代价是：
 * 拿不到 Web 的审批通道、不进 trace 树、不受任务租约约束、也没法离线评测。
 * 这里改为**进程内的子会话**，全部复用已有底座：
 *
 * - 子会话通过 `AgentRegistry` 创建与登记（审批、事件、账本自动生效），并落在
 *   `~/.pi/agent-node-server/subagents/`（可查、可展开，**不进 CLI 的会话列表**）；
 * - 账本按 `parent_run_id` 把子 run 挂到父 run 下（M1 建表时已留列）；
 * - 危险命令审批共用同一个 `ToolApprovalBroker`，弹窗出现在**父会话**界面；
 * - 预算（轮数 / token / 成本 / 时限）在服务端按事件计数执行，不看模型自报。
 *
 * 三条不变量：
 * 1. **深度是结构保证**：到 `maxDepth` 的子会话连 `subagent` 工具都不会注册，
 *    而不是靠运行时拦截（模型没法"试一下"）。
 * 2. **超限要如实上报**：预算是硬约束——超了就 abort 并把已产出的摘要带回去，
 *    绝不"尽量省"。
 * 3. **一定要收尾**：成功/失败/超预算/取消/服务关闭，子会话都会被移除并释放资源。
 */

import { join, dirname } from 'node:path';

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import type { AgentRegistry, CreateSessionInput, PiSession } from './agent-registry.js';
import type { ServiceLogger } from './service-logger.js';
import type { SessionLedger } from './observability/session-ledger.js';
import {
  discoverSubagentPresets,
  isReadOnlyPreset,
  type SubagentPreset,
} from './subagent-presets.js';
import { modelNote, resolveSubagentModel, type ResolvedSubagentModel } from './subagent-models.js';
import { buildSubagentTools, type SubagentToolbox } from './subagent-tools.js';

/** 子会话强制关闭的能力：子任务不问用户、不自己规划（避免嵌套状态机）。 */
export const SUBAGENT_EXTENSIONS: CreateSessionInput['extensions'] = {
  approval: true,
  planMode: false,
  questions: false,
};

/** 并发与深度上限。 */
export interface SubagentLimits {
  /** 允许的委派层数：1 = 子会话不能再委派（默认）。 */
  maxDepth: number;
  /** 全局同时运行的子会话数。 */
  maxConcurrent: number;
  /** 单个父会话同时运行的子会话数。 */
  maxPerParent: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  maxDepth: 1,
  maxConcurrent: 3,
  maxPerParent: 4,
};

/**
 * 一次委派的预算。
 * 中文说明：`maxTokens` 是主约束，`maxCostUsd` 只是「provider 如实上报成本时才生效」的补充——
 * 本机 deepseek 上报的 `cost.total` 恒为 0，只靠美元上限等于没有预算。
 */
export interface SubagentBudget {
  maxTurns: number;
  maxTokens: number;
  maxCostUsd?: number;
  timeoutMs: number;
}

export const DEFAULT_SUBAGENT_BUDGET: SubagentBudget = {
  maxTurns: 12,
  maxTokens: 200_000,
  timeoutMs: 10 * 60_000,
};

/** 单个子会话的轮数上限默认值（不同预设档位不同）。 */
export const PRESET_BUDGETS: Record<string, Partial<SubagentBudget>> = {
  scout: { maxTurns: 12, maxTokens: 150_000 },
  planner: { maxTurns: 8, maxTokens: 100_000 },
  reviewer: { maxTurns: 8, maxTokens: 120_000 },
  worker: { maxTurns: 20, maxTokens: 300_000 },
};

export type SubagentStatus =
  'completed' | 'failed' | 'aborted' | 'budget_exceeded' | 'timeout' | 'unavailable';

export interface SubagentUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface SubagentRequest {
  parentSessionId: string;
  cwd: string;
  /** 预设名（`~/.pi/agent/agents/*.md` 里的 name）。 */
  preset: string;
  prompt: string;
  /** **本次子会话**的深度（父会话深度 + 1；父会话深度 0）。 */
  depth: number;
  budget?: Partial<SubagentBudget>;
  /** 覆盖预设模型（`provider/model`、裸 id 或 `inherit`）。 */
  model?: string;
  signal?: AbortSignal;
}

export interface SubagentResult {
  status: SubagentStatus;
  /** 回传父会话的摘要（默认截断到 MAX_SUMMARY_CHARS）。 */
  summary: string;
  preset: string;
  depth: number;
  usage: SubagentUsage;
  durationMs: number;
  subagentSessionId?: string;
  runId?: string;
  model?: { provider: string; id: string };
  /** 失败/截断原因（status 非 completed 时给出）。 */
  reason?: string;
  /** 模型回退等需要让人知道的说明。 */
  note?: string;
  /** 预设不存在时给出可选清单。 */
  missingPresets?: string[];
  /** 子会话调用过的工具（供前端展示轨迹）。 */
  trajectory: Array<{ tool: string; ok: boolean }>;
}

export interface SubagentServiceOptions {
  agentDir: string;
  /** 子会话 JSONL 的落盘目录（默认 `<agentDir>/../agent-node-server/subagents`）。 */
  sessionDir?: string;
  limits?: Partial<SubagentLimits>;
  logger?: ServiceLogger;
  now?: () => number;
}

/** 运行中的子会话（用于取消级联与状态展示）。 */
interface RunningSubagent {
  childSessionId: string;
  parentSessionId: string;
  preset: string;
  depth: number;
  startedAt: number;
  /** 结案：终止子会话并记下原因（重复调用只有第一次生效）。 */
  stop: (status: SubagentStatus, reason: string) => void;
}

const MAX_SUMMARY_CHARS = 8_000;
const MAX_RECORDS_PER_SESSION = 50;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, limit: number = MAX_SUMMARY_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（摘要过长已截断，完整轨迹见子会话 ${limit}/${text.length} 字符）`;
}

/** 把 assistant 消息的内容块拼成纯文本。 */
function textOfMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const typed = block as { type?: string; text?: string };
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** 取最后一条 assistant 消息（摘要与结束原因都从它读）。 */
function lastAssistantMessage(messages: readonly unknown[]): unknown | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === 'object' &&
      (message as { role?: string }).role === 'assistant'
    )
      return message;
  }
  return undefined;
}

export class SubagentService {
  /** 生效中的上限（只读：构造后不再变，工具描述与状态展示会读它）。 */
  readonly limits: SubagentLimits;
  private readonly sessionDir: string;
  private readonly running = new Map<string, RunningSubagent>();
  private readonly records = new Map<string, SubagentResult[]>();
  private factory:
    | {
        create(input: CreateSessionInput): Promise<PiSession>;
        resolveSubagentModel?(input: {
          spec?: string;
          fallback?: { provider: string; id: string };
        }): Promise<ResolvedSubagentModel>;
      }
    | undefined;
  private registry: AgentRegistry | undefined;
  private ledger: SessionLedger | undefined;
  /** 并发闸门：全局在跑数 + 每个父会话在跑数 + FIFO 等待队列。 */
  private active = 0;
  private readonly activeByParent = new Map<string, number>();
  private readonly waiters: Array<{
    parentSessionId: string;
    resolve: (release: (() => void) | undefined) => void;
  }> = [];

  constructor(private readonly options: SubagentServiceOptions) {
    this.limits = { ...DEFAULT_SUBAGENT_LIMITS, ...options.limits };
    this.sessionDir =
      options.sessionDir ?? join(dirname(options.agentDir), 'agent-node-server', 'subagents');
  }

  /**
   * 绑定注册表与工厂。
   * 中文说明：这里用延迟绑定（而不是构造函数注入）是因为存在依赖环——工厂的
   * `loader()` 需要本服务来注册 `subagent` 工具，而本服务需要工厂来创建子会话。
   * 与本项目既有的 `plans.setTaskService()` / `plans.setExecutor()` 同一手法。
   */
  attach(input: {
    registry: AgentRegistry;
    factory: SubagentService['factory'];
    ledger?: SessionLedger;
  }): void {
    this.registry = input.registry;
    this.factory = input.factory;
    this.ledger = input.ledger;
  }

  /** 子会话落盘目录（服务层参数，测试可断言）。 */
  getSessionDir(): string {
    return this.sessionDir;
  }

  /**
   * 生成 `subagent` 工具的内联扩展。
   * 中文说明：`depth` 是**调用方会话自己的深度**（用户会话 0），工具会把子会话深度算成
   * `depth + 1`；到 `maxDepth` 的会话根本不会走到这里（loader 按条件不注册本扩展）。
   */
  buildExtension(options: { depth: number }): InlineExtension {
    const service = this;
    const toolbox: SubagentToolbox = {
      listPresets: (cwd) => service.listPresets(cwd),
      run: (request) => service.run(request),
      context: () => ({ depth: options.depth, maxDepth: service.limits.maxDepth }),
    };
    return (pi: ExtensionAPI) => {
      for (const tool of buildSubagentTools(toolbox)) pi.registerTool(tool);
    };
  }

  /** 当前可用的预设（工具参数校验、Plan 模式放行判定、前端展示都用它）。 */
  listPresets(cwd: string): SubagentPreset[] {
    return discoverSubagentPresets({ agentDir: this.options.agentDir, cwd });
  }

  /** 只读预设判定（Plan 模式下只放行这类预设）。 */
  isReadOnlyPreset(cwd: string, preset: string): boolean {
    const found = this.listPresets(cwd).find((item) => item.name === preset);
    return found !== undefined && isReadOnlyPreset(found);
  }

  /** 某个父会话最近的子任务记录（倒序，供前端面板展示）。 */
  listForSession(parentSessionId: string): SubagentResult[] {
    return [...(this.records.get(parentSessionId) ?? [])].reverse();
  }

  /** 正在运行的子会话数（全局）。 */
  activeCount(): number {
    return this.active;
  }

  /**
   * 执行一次委派。
   * 中文说明：这是本服务的唯一入口。返回的 `SubagentResult` 而不是抛异常——
   * 子任务失败属于「父会话应该看到并自己决策」的信息，不是父会话的崩溃。
   */
  async run(request: SubagentRequest): Promise<SubagentResult> {
    const startedAt = this.now();
    const budget: SubagentBudget = {
      ...DEFAULT_SUBAGENT_BUDGET,
      ...(PRESET_BUDGETS[request.preset] ?? {}),
      ...(request.budget ?? {}),
    };
    const base: SubagentResult = {
      status: 'unavailable',
      summary: '',
      preset: request.preset,
      depth: request.depth,
      usage: emptyUsage(),
      durationMs: 0,
      trajectory: [],
    };
    const finish = (result: SubagentResult): SubagentResult => {
      const finalized: SubagentResult = { ...result, durationMs: this.now() - startedAt };
      this.remember(request.parentSessionId, finalized);
      return finalized;
    };

    if (this.registry === undefined || this.factory === undefined)
      return finish({ ...base, reason: 'subagent service is not attached' });
    if (request.depth > this.limits.maxDepth)
      return finish({
        ...base,
        status: 'failed',
        reason: `超过委派深度上限 ${this.limits.maxDepth}`,
      });

    const preset = this.listPresets(request.cwd).find((item) => item.name === request.preset);
    if (preset === undefined) {
      const available = this.listPresets(request.cwd).map((item) => item.name);
      return finish({
        ...base,
        status: 'failed',
        missingPresets: available,
        reason: `未知预设「${request.preset}」`,
        summary: `没有名为「${request.preset}」的子 agent 预设。可用预设：${
          available.join(', ') || '（无，请在 ~/.pi/agent/agents/ 下新建 .md）'
        }`,
      });
    }

    const parent = this.registry.get(request.parentSessionId);
    const parentModel = parent?.session.model;
    const resolved = await this.resolveModel(request, preset, parentModel);

    // 并发闸门：超限排队而不是拒绝（子任务不该因为「同时有 4 个」直接失败）。
    const release = await this.acquireSlot(request.parentSessionId, request.signal);
    if (release === undefined)
      return finish({ ...base, status: 'aborted', reason: '委派在排队期间被取消' });

    let child: PiSession | undefined;
    try {
      child = await this.createChild(request, preset, resolved.model);
      const childSessionId = child.sessionId;
      const outcome: { status?: SubagentStatus; reason?: string } = {};
      const usage = emptyUsage();
      const trajectory: Array<{ tool: string; ok: boolean }> = [];
      const stop = (status: SubagentStatus, reason: string): void => {
        if (outcome.status !== undefined) return;
        outcome.status = status;
        outcome.reason = reason;
        void child?.abort().catch(() => undefined);
      };
      const running: RunningSubagent = {
        childSessionId,
        parentSessionId: request.parentSessionId,
        preset: preset.name,
        depth: request.depth,
        startedAt,
        stop,
      };
      this.running.set(childSessionId, running);

      // 预算按事件计数（不看模型自报）：轮数、token、成本各超一次即中止。
      const unsubscribe = child.subscribe((event) => {
        if (event.type === 'turn_start') {
          usage.turns += 1;
          if (usage.turns > budget.maxTurns)
            stop('budget_exceeded', `超过最大轮数 ${budget.maxTurns}`);
          return;
        }
        if (event.type === 'tool_execution_end') {
          trajectory.push({ tool: event.toolName, ok: !event.isError });
          return;
        }
        if (event.type !== 'message_end') return;
        const message = event.message as unknown as {
          role?: string;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cost?: { total?: number };
          };
        };
        if (message.role !== 'assistant') return;
        const delta = message.usage;
        if (delta === undefined) return;
        usage.inputTokens += delta.input ?? 0;
        usage.outputTokens += delta.output ?? 0;
        usage.cacheReadTokens += delta.cacheRead ?? 0;
        usage.costUsd += delta.cost?.total ?? 0;
        const totalTokens = usage.inputTokens + usage.outputTokens;
        if (totalTokens > budget.maxTokens)
          stop('budget_exceeded', `超过 token 预算 ${budget.maxTokens}（已用 ${totalTokens}）`);
        else if (budget.maxCostUsd !== undefined && usage.costUsd > budget.maxCostUsd)
          stop('budget_exceeded', `超过成本预算 $${budget.maxCostUsd}`);
      });

      const timer = setTimeout(
        () => stop('timeout', `超过时限 ${budget.timeoutMs}ms`),
        budget.timeoutMs,
      );
      const onAbort = (): void => stop('aborted', '父会话取消了这次委派');
      request.signal?.addEventListener('abort', onAbort, { once: true });

      let failure: string | undefined;
      try {
        await child.prompt(request.prompt);
      } catch (error) {
        failure = messageOf(error);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        unsubscribe();
        this.running.delete(childSessionId);
      }

      const summary = truncate(textOfMessage(lastAssistantMessage(child.messages)));
      const lastMessage = lastAssistantMessage(child.messages) as
        { stopReason?: string; errorMessage?: string } | undefined;
      const status = this.statusOf({ outcome, failure, lastMessage });
      const knownRun = this.ledger?.lastRunId(childSessionId);
      const result: SubagentResult = {
        ...base,
        status,
        summary,
        usage,
        trajectory,
        subagentSessionId: childSessionId,
        ...(knownRun === undefined ? {} : { runId: knownRun }),
        ...(resolved.model === undefined ? {} : { model: resolved.model }),
        ...(modelNote(resolved) === undefined ? {} : { note: modelNote(resolved) }),
        ...(outcome.reason === undefined && status !== 'failed'
          ? {}
          : { reason: outcome.reason ?? failure ?? lastMessage?.errorMessage }),
      };
      this.options.logger?.info(
        {
          parentSessionId: request.parentSessionId,
          subagentSessionId: childSessionId,
          preset: preset.name,
          depth: request.depth,
          status,
          turns: usage.turns,
          tokens: usage.inputTokens + usage.outputTokens,
          costUsd: usage.costUsd,
          durationMs: this.now() - startedAt,
        },
        'subagent finished',
      );
      return finish(result);
    } catch (error) {
      return finish({
        ...base,
        status: 'failed',
        reason: messageOf(error),
        summary: `子会话未能启动：${messageOf(error)}`,
      });
    } finally {
      release();
      if (child !== undefined) await this.release(child.sessionId);
    }
  }

  /**
   * 取消一个父会话下的所有子任务（父会话 abort / 任务取消 / 会话关闭 / 服务关闭）。
   * 中文说明：同时处理「在跑的」与「排队中的」——只 abort 在跑的那些，
   * 排队中的子任务会在父会话结束后启动，那才是真正的泄漏。
   */
  abortAll(parentSessionId: string, reason = '父会话已结束'): void {
    for (const running of [...this.running.values()]) {
      if (running.parentSessionId === parentSessionId) running.stop('aborted', reason);
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.parentSessionId !== parentSessionId) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(undefined);
    }
  }

  /** 取消所有子任务（服务关闭）。 */
  abortAllSessions(reason = '服务已关闭'): void {
    for (const parentSessionId of new Set(
      [...this.running.values()].map((running) => running.parentSessionId),
    )) {
      this.abortAll(parentSessionId, reason);
    }
    for (const waiter of [...this.waiters]) waiter.resolve(undefined);
    this.waiters.length = 0;
  }

  /** 运行中的子会话记录（测试与状态展示用）。 */
  runningList(): Array<{ childSessionId: string; parentSessionId: string; preset: string }> {
    return [...this.running.values()].map(({ childSessionId, parentSessionId, preset }) => ({
      childSessionId,
      parentSessionId,
      preset,
    }));
  }

  private statusOf(input: {
    outcome: { status?: SubagentStatus; reason?: string };
    failure?: string;
    lastMessage?: { stopReason?: string; errorMessage?: string };
  }): SubagentStatus {
    if (input.outcome.status !== undefined) return input.outcome.status;
    if (input.failure !== undefined) return 'failed';
    const stopReason = input.lastMessage?.stopReason;
    if (stopReason === 'aborted') return 'aborted';
    if (stopReason === 'error') return 'failed';
    return 'completed';
  }

  /** 创建并登记子会话（走注册表，审批/事件/账本自动生效）。 */
  private async createChild(
    request: SubagentRequest,
    preset: SubagentPreset,
    model: { provider: string; id: string } | undefined,
  ): Promise<PiSession> {
    const registry = this.registry!;
    const parentEntry = registry.get(request.parentSessionId);
    const parentSessionPath = parentEntry?.session.sessionManager?.getSessionFile();
    const parentRunId = this.ledger?.currentRunId(request.parentSessionId);
    const depth = request.depth;
    const entry = await registry.create({
      cwd: request.cwd,
      ...(model === undefined ? {} : { provider: model.provider, modelId: model.id }),
      // 子会话的工具集就是预设的工具集（不并入内联工具）：只读预设必须真的只读。
      ...(preset.tools === undefined ? {} : { toolNames: preset.tools }),
      ...(preset.systemPrompt.trim() ? { systemPrompt: preset.systemPrompt } : {}),
      extensions: SUBAGENT_EXTENSIONS,
      subagent: {
        parentSessionId: request.parentSessionId,
        parentRunId,
        preset: preset.name,
        depth,
        sessionDir: this.sessionDir,
        ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
        maxDepth: this.limits.maxDepth,
      },
    });
    return entry.session;
  }

  /**
   * 解析预设模型：请求覆盖 → 预设 → 继承父会话。
   * 中文说明：解析需要模型目录（`getModels` / `hasConfiguredAuth`），而目录属于工厂
   * （它持有 ModelRuntime）。因此解析动作交给工厂执行，服务只传「想要什么 + 兜底是什么」。
   */
  private async resolveModel(
    request: SubagentRequest,
    preset: SubagentPreset,
    parentModel: { provider: string; id: string } | undefined,
  ): Promise<ResolvedSubagentModel> {
    const spec = request.model ?? preset.model;
    const input = {
      ...(spec === undefined ? {} : { spec }),
      ...(parentModel === undefined ? {} : { fallback: parentModel }),
    };
    if (this.factory?.resolveSubagentModel !== undefined)
      return this.factory.resolveSubagentModel(input);
    return resolveSubagentModel(input);
  }

  /** 收尾：把子会话从注册表移除（保留磁盘上的 JSONL 供回看）。 */
  private async release(childSessionId: string): Promise<void> {
    try {
      await this.registry?.remove(childSessionId);
    } catch (error) {
      this.options.logger?.warn(
        { childSessionId, error: messageOf(error) },
        'subagent session cleanup failed',
      );
    }
  }

  private remember(parentSessionId: string, result: SubagentResult): void {
    const list = this.records.get(parentSessionId) ?? [];
    list.push(result);
    if (list.length > MAX_RECORDS_PER_SESSION) list.shift();
    this.records.set(parentSessionId, list);
  }

  private canStart(parentSessionId: string): boolean {
    return (
      this.active < this.limits.maxConcurrent &&
      (this.activeByParent.get(parentSessionId) ?? 0) < this.limits.maxPerParent
    );
  }

  private takeSlot(parentSessionId: string): void {
    this.active += 1;
    this.activeByParent.set(parentSessionId, (this.activeByParent.get(parentSessionId) ?? 0) + 1);
  }

  private releaseSlot(parentSessionId: string): void {
    this.active -= 1;
    const next = (this.activeByParent.get(parentSessionId) ?? 1) - 1;
    if (next <= 0) this.activeByParent.delete(parentSessionId);
    else this.activeByParent.set(parentSessionId, next);
    this.drain();
  }

  /** 排队：拿到名额才返回 release 闭包；排队期间被取消返回 undefined。 */
  private acquireSlot(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<(() => void) | undefined> {
    if (this.canStart(parentSessionId)) {
      this.takeSlot(parentSessionId);
      return Promise.resolve(() => this.releaseSlot(parentSessionId));
    }
    if (signal?.aborted === true) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = { parentSessionId, resolve };
      signal?.addEventListener(
        'abort',
        () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(undefined);
        },
        { once: true },
      );
      this.waiters.push(waiter);
    });
  }

  /** 释放名额后唤醒队列（跳过错过的父会话，避免它把别人饿死）。 */
  private drain(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index];
      if (!this.canStart(waiter.parentSessionId)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      this.takeSlot(waiter.parentSessionId);
      waiter.resolve(() => this.releaseSlot(waiter.parentSessionId));
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function emptyUsage(): SubagentUsage {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

/**
 * 原版 Pi 会话注册表与事件重放缓冲区。
 *
 * 中文说明：这是 Node 后端的"心脏"。
 * - 每个会话只保留一个活跃的原版 Pi AgentSession（用 Map<sessionId, entry> 管理）；
 * - Pi SDK 产生的事件被原样缓存在内存（每会话最多 MAX_REPLAY_EVENTS 条），
 *   由 SSE 路由推送给现有 Vue 前端；新订阅者/断线重连时按 id 补发历史事件；
 * - 本文件刻意不依赖 Fastify，只做纯业务逻辑，便于单元测试。
 *
 * Pi SDK 关键概念（来自 @earendil-works/pi-coding-agent）：
 * - ModelRuntime：模型运行时，读取 auth.json（凭据）与 models.json（模型目录），
 *   负责按 provider/modelId 解析模型实例；
 * - DefaultResourceLoader：资源加载器，加载工具（tools）、技能（skills）等；
 * - SessionManager：会话管理器，负责把会话持久化为 JSONL 文件、管理消息树；
 * - createAgentSession()：给定上述依赖创建一个 AgentSession（一次对话的实例）；
 * - AgentSession：会话实例，有 prompt()/steer()/abort() 等方法，
 *   并通过 subscribe(listener) 发布 AgentSessionEvent 事件流。
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionSettings,
  type InlineExtension,
  type LoadExtensionsResult,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ApiError } from '../errors.js';
import type { ServiceLogger } from './service-logger.js';
import { previewOf } from './service-logger.js';
import { ToolApprovalBroker, type PendingToolApproval } from './tool-approval.js';
import { PlanModeService } from './plan-mode-service.js';
import { PLAN_TOOL_NAMES } from './plan-tools.js';
import { ASK_USER_TOOL_NAME, type PendingQuestion, type QuestionBroker } from './user-question.js';
import { emptyPlanView, type PlanView } from './platform/plan-model.js';
import { SessionLedger, type LedgerSessionContext } from './observability/session-ledger.js';
import { buildMcpExtension } from './mcp/mcp-extension.js';
import type { McpService } from './mcp/mcp-service.js';
import type { TaskRecord } from './platform/task-model.js';
import type { TaskRecoveryItem } from './task-recovery.js';
import { resolveSubagentModel, type ResolvedSubagentModel } from './subagent-models.js';
import type { SubagentService } from './subagent-service.js';

/** 每个会话内存中最多缓存的 SSE 事件条数（超出后丢弃最旧的）。 */
const MAX_REPLAY_EVENTS = 256;

/**
 * 事件载荷是不是 SDK 的流式增量。
 * 中文说明：SDK 每个 token 产生一条 `message_update`，且每条带整条累计消息的快照；
 * 重放时只保留每段连续增量的最后一条，避免客户端一建连就重渲染几百次。
 */
function isMessageUpdatePayload(payload: StreamEvent['payload'] | undefined): boolean {
  return payload?.type === 'message_update';
}

/**
 * 由服务端“内联扩展”接管的扩展目录名。
 *
 * 中文说明：SDK 的 DefaultResourceLoader 会自动发现 `~/.pi/agent/extensions/` 与
 * `{cwd}/.pi/extensions/`。如果用户在这两个位置装了**同名**扩展（例如官方自带的
 * `plan-mode`），它会与我们的内联实现同时生效，形成两套状态机：
 * - 两者都钩 tool_call，而 SDK 在首个 `{block:true}` 后短路 → 拦截规则不可预测；
 * - 两者都钩 before_agent_start / agent_end / turn_end → 上下文重复注入、状态双写；
 * - 官方实现会从**共享的会话 JSONL** 里恢复自己的状态（`customType: "plan-mode"`），
 *   因此 CLI 里敲过 `/plan` 的会话会在 Web 侧“隐形地”进入规划期。
 *
 * 这里按**目录名**过滤掉被内联实现接管的那几个，只影响本服务的资源加载，
 * **不修改、不删除用户目录里的任何文件**（CLI 仍照常加载它们）。
 */
export const INLINE_OWNED_EXTENSION_DIRS = ['plan-mode', 'subagent'] as const;

/** 从 unknown 错误里取出可读消息（不泄露堆栈）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从扩展路径中取出它所在的目录名（用于识别被内联实现接管的扩展）。
 * 例：`.../extensions/plan-mode/index.ts` → `plan-mode`。
 */
function extensionDirName(path: string): string | undefined {
  const segments = path.split(/[\\/]/);
  const index = segments.lastIndexOf('extensions');
  return index >= 0 ? segments[index + 1] : undefined;
}

/**
 * 过滤掉被内联实现接管的同名文件扩展（只影响本服务的资源加载）。
 * 返回被过滤掉的路径，供调用方记日志。
 */
export function dropInlineOwnedExtensions(result: LoadExtensionsResult): {
  result: LoadExtensionsResult;
  dropped: string[];
} {
  const owned = new Set<string>(INLINE_OWNED_EXTENSION_DIRS);
  const dropped: string[] = [];
  const extensions = result.extensions.filter((extension) => {
    // 内联扩展的 path 形如 `<inline:N>`，不会被误伤（其目录名取不到）。
    const name = extensionDirName(extension.path);
    if (name === undefined || !owned.has(name)) return true;
    dropped.push(extension.path);
    return false;
  });
  return { result: { ...result, extensions }, dropped };
}

/**
 * 模型响应日志所需的 assistant 消息元数据（结构化子集）。
 * 中文说明：SDK 的 AgentMessage 联合类型未直接暴露 AssistantMessage 形状，
 * 这里按需声明，避免依赖 SDK 内部类型路径。
 */
interface AssistantMessageMeta {
  role: 'assistant';
  provider: string;
  model: string;
  stopReason: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    totalTokens: number;
    cost?: { total: number };
  };
}

/** 图片附件（模型视觉输入）：base64 数据 + MIME 类型。 */
export interface ImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
}

/** 子会话的委派链路（M5）：登记进注册表时带上，用于 trace 树、取消级联与「不递归」保证。 */
export interface SubagentLink {
  parentSessionId: string;
  /** 父会话当前正在跑的 run id（账本把它写进子 run 的 parent_run_id）。 */
  parentRunId?: string;
  /** 预设名（`~/.pi/agent/agents/*.md` 的 name）。 */
  preset: string;
  /** 子会话自身的深度（父会话 0，子会话 1）。 */
  depth: number;
  /** 子会话 JSONL 落盘目录（默认由服务层给出 `~/.pi/agent-node-server/subagents`）。 */
  sessionDir?: string;
  /** 父会话的 JSONL 路径（写进子会话头部，形成 parentSession 链）。 */
  parentSessionPath?: string;
  /** 允许的最大深度；`depth >= maxDepth` 时子会话不再注册 `subagent` 工具（结构上不可递归）。 */
  maxDepth: number;
}

/** 创建会话的输入参数（来自 POST /api/agent/new）。 */
export interface CreateSessionInput {
  cwd: string; // 工作区目录
  provider?: string; // 模型提供方（如 anthropic）
  modelId?: string; // 模型 id（如 claude-sonnet-4-5）
  thinkingLevel?: string; // 思考强度（off/minimal/low/medium/high/xhigh/max）
  toolNames?: string[]; // 启用的工具白名单
  systemPrompt?: string; // 预设系统提示词；空串/未提供 = SDK 默认
  compaction?: CompactionSettings; // 预设上下文压缩策略；未提供 = SDK 默认
  /** 预设可关闭的能力开关；未指定一律开启。 */
  extensions?: {
    approval?: boolean; // 危险命令人工审批
    planMode?: boolean; // Web Plan 模式
    questions?: boolean; // 向用户提问（ask_user，默认启用）
  };
  /** MCP 服务白名单；null/缺省 = 全部，[] = 禁用，非空数组 = 服务名白名单（预设的 mcpServers 字段）。 */
  mcpServers?: string[] | null;
  /** M5：本会话是某次委派的子会话时提供（缺省 = 用户会话）。 */
  subagent?: SubagentLink;
}

/** 磁盘上持久化会话的元信息（从 SessionManager.listAll 的 SessionInfo 转换而来）。 */
export interface PersistedSessionInfo {
  id: string;
  path: string; // 会话 JSONL 文件路径
  cwd: string;
  name?: string; // 用户自定义名称
  parentSessionPath?: string; // 父会话文件路径（fork 产生）
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

/** 打开持久化会话所需的输入（目前与 PersistedSessionInfo 相同）。 */
export interface OpenSessionInput extends PersistedSessionInfo {}

/**
 * 会话的门面接口（Facade）。
 * 中文说明：这是本服务层对"一个 Pi 会话"的最小抽象，屏蔽了 Pi SDK 的复杂类型；
 * 路由层只需要跟这个接口打交道。实现由 OriginalPiSessionFactory 提供
 * （把 createAgentSession 返回的对象强转成这个接口）。
 */
export interface PiSession {
  readonly sessionId: string;
  readonly isStreaming: boolean; // 是否正在流式输出
  readonly thinkingLevel: string;
  readonly model: { provider: string; id: string } | undefined;
  readonly messages: unknown[]; // 当前消息列表
  readonly isCompacting: boolean; // 是否正在压缩上下文
  readonly retryAttempt: number; // 当前重试次数
  readonly modelRuntime: {
    getModel(provider: string, modelId: string): { provider: string; id: string } | undefined;
  };
  // 持久化相关（会话可能还没持久化，所以可选）：
  readonly sessionManager?: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    getLeafId(): string | null;
    getTree(): unknown[];
    buildContextEntries(): unknown[];
    buildSessionContext(): {
      messages: unknown[];
      thinkingLevel: string;
      model: { provider: string; modelId: string } | null;
    };
  };
  getActiveToolNames(): string[];
  /**
   * 会话累计统计（SDK 的 AgentSession.getSessionStats）：消息数、工具调用数、
   * token 用量与累计成本。可选：假会话/旧实现可能不提供。
   */
  getSessionStats?(): unknown;
  /**
   * 上下文占用（SDK 的 AgentSession.getContextUsage）：tokens / contextWindow / percent。
   * 中文说明：SDK 在刚压缩完、下一次响应前会返回 tokens=null（占用未知），
   * 这里原样透传，由前端自行决定展示方式。
   */
  getContextUsage?(): unknown;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void; // 返回取消订阅函数
  /**
   * 绑定扩展运行时（SDK 的 AgentSession.bindExtensions）。
   *
   * 中文说明：**这是 `session_start` 扩展事件的唯一发出点**——SDK 里只有
   * interactive / print / rpc 三种 CLI mode 会调它，直接调 `createAgentSession()`
   * 不会发 `session_start`。若不调用，所有依赖该钩子做初始化的扩展
   * （如 PlanModeService 的状态机登记与 JSONL 恢复）永远不会生效。
   * 传空对象即“无额外绑定”，只触发事件。
   */
  bindExtensions?(bindings?: Record<string, unknown>): Promise<void>;
  prompt(message: string, options?: { images?: ImageAttachment[] }): Promise<void>;
  steer(message: string, images?: ImageAttachment[]): Promise<void>;
  followUp(message: string, images?: ImageAttachment[]): Promise<void>;
  abort(): Promise<void>;
  setModel(model: { provider: string; id: string }): Promise<void>;
  setThinkingLevel(level: string): void;
  setActiveToolsByName(toolNames: string[]): void;
  compact(customInstructions?: string): Promise<unknown>;
  navigateTree(targetId: string): Promise<unknown>;
  reload(): Promise<void>;
  dispose(): void; // 释放资源（取消事件监听等）
}

/**
 * 会话工厂接口：负责"创建新会话 / 列出持久化会话 / 打开持久化会话"。
 * 中文说明：抽象成接口后，测试可以注入假工厂，不依赖真实 Pi SDK 和磁盘。
 */
export interface PiSessionFactory {
  create(input: CreateSessionInput): Promise<PiSession>;
  listPersistedSessions?(): Promise<PersistedSessionInfo[]>;
  open?(input: OpenSessionInput): Promise<PiSession>;
  reloadModelRuntime?(): void;
  /**
   * 解析子会话预设里的 `model:`（M5）。
   * 中文说明：模型目录（`getModels` / `hasConfiguredAuth`）属于持有 ModelRuntime 的工厂，
   * 所以解析放在这里；返回的 `note` 说明是否发生了「回退父会话模型」。
   */
  resolveSubagentModel?(input: {
    spec?: string;
    fallback?: { provider: string; id: string };
  }): Promise<ResolvedSubagentModel>;
}

/**
 * 推送给前端的 SSE 事件。
 * payload 有三类：Pi SDK 原始事件（AgentSessionEvent）、
 * 会话结束错误事件（agent_end）、工具审批待处理事件（tool_call_pending）。
 */
export interface StreamEvent {
  id: number; // 单调递增的事件序号，前端用 Last-Event-ID 断线续传
  payload:
    | AgentSessionEvent
    | { type: 'agent_end'; error: string }
    | { type: 'plan_updated'; plan: PlanView }
    | { type: 'task_updated'; task: TaskRecord }
    | { type: 'task_recovery_required'; tasks: TaskRecoveryItem[] }
    | { type: 'question_pending'; question: PendingQuestion }
    | { type: 'question_resolved'; questionId: string }
    | {
        type: 'tool_call_pending';
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        reason: string;
        rule: string;
        risk: 'medium' | 'high' | 'critical';
        category:
          | 'workspace_write'
          | 'dependency_change'
          | 'network'
          | 'git_remote'
          | 'destructive'
          | 'system';
        /** M5：子会话发起的审批——真正要执行工具的是这个会话。 */
        sessionId?: string;
        /** M5：弹窗显示在哪个会话上（子会话的审批挂到父会话的流）。 */
        parentSessionId?: string;
        /** M5：子会话的预设名（弹窗上标注「子任务 scout 请求执行 …」）。 */
        agent?: string;
      };
}

/** 注册表条目：一个活跃会话 + 它的事件缓存 + 订阅者集合。 */
export interface RegistryEntry {
  session: PiSession;
  cwd: string;
  createdAt: Date;
  events: StreamEvent[]; // 事件缓存（断线重放用）
  nextEventId: number; // 下一条事件的序号
  unsubscribe: () => void; // 取消对 SDK 事件的订阅
  subscribers: Set<(event: StreamEvent) => void>; // 当前 SSE 连接的监听器
  persisted?: PersistedSessionInfo;
  /** 工具调用计时（toolCallId → 开始时刻），用于日志统计执行耗时。 */
  toolStartTimes: Map<string, number>;
  /** 本轮模型请求发出时刻（turn_start 记录），message_end 时算响应耗时。 */
  turnStartedAt?: number;
  /** 本会话当前执行的任务 id（有值时账本会把它写进 run.task_id）。 */
  activeTaskId?: string;
  /** M5：本会话是由某次委派创建的子会话时提供（用于 trace 树与取消级联）。 */
  subagent?: SubagentLink;
}

/**
 * SDK 适配器：凭据与模型元数据仍由原版 Pi 文件（auth.json / models.json）管理，
 * 本类只负责把它们组装成 createAgentSession 需要的依赖。
 */
export class OriginalPiSessionFactory implements PiSessionFactory {
  /** ModelRuntime 是重量级对象（要读文件、可能起子进程），做单例缓存。 */
  private runtimePromise: Promise<ModelRuntime> | undefined;
  /** 运行时来源（默认读 agentDir 下的凭据/模型文件；测试可覆盖，见 useRuntime）。 */
  private runtimeProvider: (() => Promise<ModelRuntime>) | undefined;

  constructor(
    private readonly agentDir: string,
    private readonly mcpService?: McpService,
    private readonly approvals?: ToolApprovalBroker,
    private readonly plans?: PlanModeService,
    private readonly logger?: ServiceLogger,
    /** 可观测性扩展：把 provider 层 HTTP 观测接入每个会话（可选）。 */
    private readonly observability?: { buildExtension(): InlineExtension },
    /** 任务恢复扩展：把 turn/tool 事件写成任务的在飞动作（M3，可选）。 */
    private readonly taskRecovery?: { buildExtension(): InlineExtension },
    /** 提问通道扩展：注册 `ask_user` 工具并把挂起问题推给前端（M4.1，可选）。 */
    private readonly questions?: { buildExtension(): InlineExtension },
    /** 子任务委派（M5）：按会话深度决定是否注册 `subagent` 工具。 */
    private readonly subagents?: SubagentService,
  ) {}

  /** 创建新会话（POST /api/agent/new 的底层实现）。 */
  async create(input: CreateSessionInput): Promise<PiSession> {
    // provider 与 modelId 必须成对出现：只给一个会导致模型解析错误。
    if ((input.provider === undefined) !== (input.modelId === undefined)) {
      throw new ApiError(422, 'invalid_model', 'provider and modelId must be provided together');
    }
    const runtime = await this.getRuntime();
    // 用模型目录解析出具体的模型实例；未指定则用 Pi 默认模型。
    const model =
      input.provider && input.modelId ? runtime.getModel(input.provider, input.modelId) : undefined;
    if (input.provider && input.modelId && model === undefined) {
      throw new ApiError(
        400,
        'model_not_found',
        `Unknown Pi model: ${input.provider}/${input.modelId}`,
      );
    }
    // 预设压缩策略：每个会话独立的 SettingsManager，仅在内存里 applyOverrides
    // （不标记 modified、不写 settings.json），默认模型/思考等级仍从设置文件解析。
    const settingsManager = input.compaction
      ? (() => {
          const manager = SettingsManager.create(input.cwd, this.agentDir);
          manager.applyOverrides({ compaction: input.compaction });
          return manager;
        })()
      : undefined;
    // 预设若指定了工具子集，SDK 的 `tools` 选项会把它当成**可用工具白名单**——
    // 不在名单里的工具连调用都会失败（"Tool xxx not found"）。因此这里必须并入
    // 内联扩展注册的工具（计划工具 / MCP 工具），否则「带预设的会话」里
    // Plan 完全不可用、MCP 工具也调不动（M4 spike 抓到的真实缺陷）。
    //
    // 子会话（M5）是例外：子会话的工具集**就是预设的工具集**，不并入任何内联工具。
    // 否则「只读预设」会因为被并入 MCP / 计划工具而不再只读，隔离性形同虚设。
    const effectiveTools = input.subagent
      ? input.toolNames
      : withInlineTools(input.toolNames, [
          ...PLAN_TOOL_NAMES,
          ASK_USER_TOOL_NAME,
          ...this.mcpToolNames(input.cwd, input.mcpServers),
        ]);
    // 子会话落盘：落在服务层指定的目录（默认 ~/.pi/agent-node-server/subagents），
    // 并写 parentSession 链；**不落共享的 ~/.pi/agent/sessions**，否则 CLI 的会话列表
    // 会凭空多出一堆子会话。
    const sessionManager = input.subagent?.sessionDir
      ? SessionManager.create(input.cwd, input.subagent.sessionDir, {
          ...(input.subagent.parentSessionPath === undefined
            ? {}
            : { parentSession: input.subagent.parentSessionPath }),
        })
      : undefined;
    // 调用 Pi SDK 创建会话；"off" 透传给 SDK（clampThinkingLevel 对任何模型都接受）。
    const session = await createAgentSession({
      cwd: input.cwd,
      agentDir: this.agentDir,
      modelRuntime: runtime,
      resourceLoader: await this.loader(
        input.cwd,
        input.systemPrompt,
        input.extensions,
        input.mcpServers,
        input.subagent,
      ),
      ...(sessionManager === undefined ? {} : { sessionManager }),
      ...(model === undefined ? {} : { model }),
      ...(input.thinkingLevel
        ? { thinkingLevel: input.thinkingLevel as AgentSession['thinkingLevel'] }
        : {}),
      ...(effectiveTools === undefined ? {} : { tools: effectiveTools }),
      ...(settingsManager === undefined ? {} : { settingsManager }),
    });
    // createAgentSession 返回 { session, agent, ... }，这里只把 session 暴露出去。
    return session.session as unknown as PiSession;
  }

  /** 当前 cwd 下已连接的 MCP 工具名（预设白名单内；未启用 MCP 时为空）。 */
  private mcpToolNames(cwd: string, allowed?: string[] | null): string[] {
    if (this.mcpService === undefined) return [];
    try {
      return this.mcpService
        .toolsFor(cwd, allowed === undefined || allowed === null ? null : new Set(allowed))
        .map((tool) => tool.name);
    } catch {
      // MCP 是增量能力：拿不到工具名不该让会话建不起来。
      return [];
    }
  }

  /** 列出磁盘上所有持久化会话（递归子目录去重）。 */
  async listPersistedSessions(): Promise<PersistedSessionInfo[]> {
    const sessionsDir = join(this.agentDir, 'sessions');
    // Pi 的会话 JSONL 文件存放在 sessions/ 下一层的子目录里（按编码后的 cwd 分组）。
    // SessionManager.listAll(customDir) 只读指定的那一层目录，所以必须把
    // sessionsDir 本身和它的所有一级子目录都扫描一遍，再按 id 去重。
    let directories: string[];
    try {
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      directories = [
        sessionsDir,
        ...entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(sessionsDir, entry.name)),
      ];
    } catch {
      // 目录不存在（比如全新安装）时返回空列表而不是报错。
      return [];
    }
    const groups = await Promise.all(
      directories.map(async (directory) => {
        try {
          return await SessionManager.listAll(directory);
        } catch {
          return []; // 单个目录损坏不影响其他目录
        }
      }),
    );
    // 同一会话可能出现在多个扫描结果里（理论上不会，防御性去重）。
    const unique = new Map(groups.flat().map((session) => [session.id, session]));
    return [...unique.values()].map((session) => this.persistedInfo(session));
  }

  /** 从磁盘恢复一个持久化会话（打开它的 JSONL 文件）。 */
  async open(input: OpenSessionInput): Promise<PiSession> {
    const runtime = await this.getRuntime();
    const sessionManager = SessionManager.open(input.path);
    const { session } = await createAgentSession({
      cwd: sessionManager.getCwd() || input.cwd, // 优先用文件里记录的 cwd
      agentDir: this.agentDir,
      modelRuntime: runtime,
      sessionManager, // 传入已有的 SessionManager，恢复该会话的完整上下文
      resourceLoader: await this.loader(sessionManager.getCwd() || input.cwd),
    });
    return session as unknown as PiSession;
  }

  /** 清空运行时缓存，下次 getRuntime() 时重新读取 auth/models 文件。 */
  reloadModelRuntime(): void {
    this.runtimePromise = undefined;
  }

  /**
   * 指定 ModelRuntime 的来源（测试/评测用）。
   * 中文说明：评测要拿**真实**工厂（工具白名单并入、子会话构造、扩展注入都是生产路径），
   * 但模型要换成脚本化的 faux provider。faux 只能注册在评测自己创建的 runtime 上，
   * 因此这里开一个注入口——不改生产默认行为（默认仍是读 auth.json/models.json）。
   */
  useRuntime(provider: () => Promise<ModelRuntime>): void {
    this.runtimeProvider = provider;
  }

  /** 解析子会话预设里的 `model:`（M5）：能解析就用，解析不了就回退父会话模型并说明原因。 */
  async resolveSubagentModel(input: {
    spec?: string;
    fallback?: { provider: string; id: string };
  }): Promise<ResolvedSubagentModel> {
    const runtime = await this.getRuntime();
    return resolveSubagentModel({ ...input, catalog: runtime });
  }

  /** 惰性创建并缓存 ModelRuntime（并发调用共享同一个实例）。 */
  private getRuntime(): Promise<ModelRuntime> {
    if (this.runtimeProvider !== undefined) {
      this.runtimePromise ??= this.runtimeProvider();
      return this.runtimePromise;
    }
    this.runtimePromise ??= ModelRuntime.create({
      authPath: join(this.agentDir, 'auth.json'),
      modelsPath: join(this.agentDir, 'models.json'),
      allowModelNetwork: false, // 不从网络刷新模型目录（离线、隐私）
    });
    return this.runtimePromise;
  }

  /** 创建资源加载器（工具/技能发现 + 内联扩展注入）。 */
  private async loader(
    cwd: string,
    systemPrompt?: string,
    extensions?: CreateSessionInput['extensions'],
    mcpServers?: CreateSessionInput['mcpServers'],
    subagent?: SubagentLink,
  ): Promise<DefaultResourceLoader> {
    // 内联扩展：不走 jiti、闭包直连服务单例，使多个会话共享同一连接/审批中枢，
    // 并支持按预设开关动态启用/禁用。仍保留 SDK 的自动发现（与 TUI 平级）加载
    // 用户级 ~/.pi/agent/extensions/ 与项目级 {cwd}/.pi/extensions/ 的扩展。
    // 顺序有讲究：plan 在 approval 之前（规划期先拦下危险命令，避免先弹审批框），
    // approval 在 mcp 之前（MCP 审批复用 broker）。
    const factories: InlineExtension[] = [];
    if (extensions?.planMode !== false && this.plans) factories.push(this.plans.buildExtension());
    if (extensions?.approval !== false && this.approvals)
      factories.push(this.approvals.buildExtension());
    // 观测扩展：只读 provider 层的两个钩子（不改请求、不阻断），排在审批之后。
    if (this.observability) factories.push(this.observability.buildExtension());
    // 任务恢复扩展（M3）：记录在飞动作 + 注入恢复摘要，同样不做决策。
    if (this.taskRecovery) factories.push(this.taskRecovery.buildExtension());
    // 提问通道（M4.1）：注册 ask_user；它不是 Plan 的一部分，默认始终启用。
    if (extensions?.questions !== false && this.questions)
      factories.push(this.questions.buildExtension());
    // 子任务委派（M5）：「不能递归」在结构上保证——到达深度上限的子会话
    // 根本不注册 `subagent` 工具，模型连试的机会都没有。
    if (this.subagents && (subagent === undefined || subagent.depth < subagent.maxDepth))
      factories.push(this.subagents.buildExtension({ depth: subagent?.depth ?? 0 }));
    // MCP 内联扩展：工厂按当前 cwd 注册已连接 server 的工具集（增删随 reload_resources 生效）；
    // mcpServers 白名单来自预设（null = 全部），只注册名单内 server 的工具。
    if (this.mcpService)
      factories.push(buildMcpExtension(this.mcpService, cwd, this.approvals, mcpServers ?? null));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      // 预设系统提示词：非空才传（空串传进去会让 loader 跳过 SYSTEM.md/AGENTS.md 发现，
      // 使"默认预设"破坏用户已有的文件级提示词）。空串/未提供 → 走 SDK 默认发现。
      ...(systemPrompt ? { systemPrompt } : {}),
      extensionFactories: factories,
      // 过滤掉被上面这些内联扩展接管的同名文件扩展。只影响本服务的资源加载，
      // 不碰磁盘：用户目录里的文件保持原样，CLI 仍会正常加载它们。
      extensionsOverride: (base) => {
        const { result, dropped } = dropInlineOwnedExtensions(base);
        if (dropped.length > 0)
          this.logger?.info(
            { cwd, dropped, ownedBy: [...INLINE_OWNED_EXTENSION_DIRS] },
            'file extensions suppressed (inline implementation owns these names)',
          );
        return result;
      },
    });
    await loader.reload();
    return loader;
  }

  /** 把 SDK 的 SessionInfo 转成我们自己的 PersistedSessionInfo。 */
  private persistedInfo(session: SessionInfo): PersistedSessionInfo {
    return {
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      parentSessionPath: session.parentSessionPath,
      created: session.created,
      modified: session.modified,
      messageCount: session.messageCount,
      firstMessage: session.firstMessage,
    };
  }
}

/**
 * 会话注册表：管理所有活跃会话 + 事件缓存 + SSE 订阅。
 * 中文说明：路由层只通过它跟会话打交道。设计要点：
 * - entries：sessionId → 活跃条目；
 * - opening：并发去重——同一个 sessionId 正在"从磁盘打开"时，第二个 open()
 *   请求直接复用同一个 Promise，避免重复打开同一会话文件；
 * - 事件双缓冲：SDK 事件先进 events 数组（供重放），同时广播给所有 subscribers。
 */
/**
 * 把内联扩展注册的工具并入预设的工具白名单。
 *
 * 中文说明：SDK 的 `tools` 选项是**可用工具白名单**——不在名单里的工具不只是「不激活」，
 * 而是调用时直接 "Tool xxx not found"。M4 的 spike ⑦ 就抓到了这个缺陷：带预设
 * （指定了 toolNames）的会话里 `submit_plan` 根本调不动，MCP 工具同理。
 * 因此预设白名单必须并入内联扩展的工具名；`toolNames` 未指定时返回 undefined
 * （让 SDK 用发现到的全部工具，保持原有语义）。
 */
export function withInlineTools(
  toolNames: string[] | undefined,
  inlineTools: readonly string[],
): string[] | undefined {
  if (toolNames === undefined) return undefined;
  return [...new Set([...toolNames, ...inlineTools])];
}

export class AgentRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly opening = new Map<string, Promise<RegistryEntry>>();

  constructor(
    private readonly sessionFactory: PiSessionFactory,
    private readonly approvals?: ToolApprovalBroker,
    private readonly plans?: PlanModeService,
    private readonly logger?: ServiceLogger,
    /** 可观测性账本：publish() 的唯一下游（可选；不传即零埋点）。 */
    private readonly ledger?: SessionLedger,
    /** 提问通道（M4.1）：挂起/结算时通过注册表发 SSE 事件。 */
    private readonly questions?: QuestionBroker,
    /** 子任务委派（M5）：会话中止/移除/服务关闭时级联停掉它派出去的子任务。 */
    private readonly subagents?: SubagentService,
  ) {
    // 工具审批待处理时，通过注册表发布一条 tool_call_pending 事件（SSE 推给前端）。
    approvals?.setPendingListener((pending) => this.announceApproval(pending));
    // 子会话的审批要能认出父会话（M5）：审批中枢只管「这个会话属于谁」，不碰会话树。
    approvals?.setParentResolver((sessionId) => {
      const link = this.entries.get(sessionId)?.subagent;
      return link === undefined
        ? undefined
        : { parentSessionId: link.parentSessionId, agent: link.preset };
    });
    plans?.setListener((plan) => this.announcePlan(plan));
    questions?.setPendingListener((question) => this.announceQuestion(question));
    questions?.setResolvedListener((sessionId, questionId) =>
      this.announceQuestionResolved(sessionId, questionId),
    );
    // 审批与 Plan 的拦截都要让账本知道（否则会被统计成工具失败）。
    if (ledger) {
      approvals?.setTraceSink(ledger);
      plans?.setTraceSink(ledger);
    }
  }

  /**
   * 创建新会话并登记。会话 id 冲突（已活跃）则 409。
   */
  async create(input: CreateSessionInput): Promise<RegistryEntry> {
    const session = await this.sessionFactory.create(input);
    const existing = this.entries.get(session.sessionId);
    if (existing !== undefined) {
      throw new ApiError(409, 'session_active', `Session ${session.sessionId} is already active`);
    }
    return this.register(session, input.cwd, new Date(), undefined, input.subagent);
  }

  /**
   * 打开会话：活跃的直接返回；否则尝试从磁盘恢复。
   * 中文说明：open 是"要么已有，要么恢复，绝不重复打开"的语义——
   * 两个并发请求同时 open 同一个会话时，通过 opening Map 共享同一个
   * openPersisted() Promise，保证磁盘文件只被打开一次。
   */
  async open(sessionId: string): Promise<RegistryEntry> {
    const active = this.entries.get(sessionId);
    if (active !== undefined) return active;
    const pending = this.opening.get(sessionId);
    if (pending !== undefined) return pending;
    // 工厂不支持持久化能力时（比如测试用的假工厂），找不到就直接 404。
    if (!this.sessionFactory.listPersistedSessions || !this.sessionFactory.open) {
      throw new ApiError(404, 'session_not_found', `Session ${sessionId} was not found`);
    }
    const operation = this.openPersisted(sessionId);
    this.opening.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      // 无论成功失败都要清理，否则下一次 open 会拿到过期的 Promise。
      this.opening.delete(sessionId);
    }
  }

  /** 会话列表 = 磁盘持久化会话 ∪ 内存活跃会话，按修改时间倒序。 */
  async listSessions(): Promise<Array<PersistedSessionInfo & { active: boolean }>> {
    const persisted = this.sessionFactory.listPersistedSessions
      ? await this.sessionFactory.listPersistedSessions()
      : [];
    const byId = new Map(persisted.map((item) => [item.id, { ...item, active: false }]));
    // 活跃会话可能还没有写盘（刚创建），要把它们并进去并标记 active: true；
    // 已持久化且活跃的则以磁盘信息为准（更新 active 标志）。
    for (const entry of this.entries.values()) {
      const existing = byId.get(entry.session.sessionId);
      byId.set(entry.session.sessionId, {
        ...(existing ?? this.activeInfo(entry)),
        active: true,
      });
    }
    return [...byId.values()].sort(
      (left, right) => right.modified.getTime() - left.modified.getTime(),
    );
  }

  /** 从磁盘查找并打开指定会话（open() 的底层实现）。 */
  private async openPersisted(sessionId: string): Promise<RegistryEntry> {
    const info = (await this.sessionFactory.listPersistedSessions!()).find(
      (item) => item.id === sessionId,
    );
    if (info === undefined)
      throw new ApiError(404, 'session_not_found', `Session ${sessionId} was not found`);
    const session = await this.sessionFactory.open!(info);
    // 打开过程中可能恰好已有别的请求登记了同一会话，避免重复登记。
    const active = this.entries.get(session.sessionId);
    if (active !== undefined) return active;
    return this.register(session, info.cwd, info.created, info);
  }

  /**
   * 把新建/恢复的会话登记进注册表，订阅它的 SDK 事件，并触发 `session_start`。
   *
   * 中文说明：顺序很重要——先 `entries.set` 再触发 `session_start`，
   * 这样扩展在 session_start 里同步产生的状态（如 Plan 状态机登记、SSE 状态快照）
   * 已经能通过注册表找到本会话。
   */
  private async register(
    session: PiSession,
    cwd: string,
    createdAt: Date,
    persisted?: PersistedSessionInfo,
    subagent?: SubagentLink,
  ): Promise<RegistryEntry> {
    if (this.entries.has(session.sessionId)) {
      throw new ApiError(409, 'session_active', `Session ${session.sessionId} is already active`);
    }
    const entry: RegistryEntry = {
      session,
      cwd,
      createdAt,
      events: [],
      nextEventId: 1, // 事件序号从 1 开始（0 表示"从头重放"）
      unsubscribe: () => undefined,
      subscribers: new Set(),
      persisted,
      toolStartTimes: new Map(),
      ...(subagent === undefined ? {} : { subagent }),
    };
    // 子会话继承父会话当前的任务绑定：这样它的 run/token 也会算在那条任务头上。
    if (subagent !== undefined) {
      const parentTaskId = this.entries.get(subagent.parentSessionId)?.activeTaskId;
      if (parentTaskId !== undefined) entry.activeTaskId = parentTaskId;
    }
    // 订阅 SDK 事件：所有事件先进缓存（publish 内部处理），再广播给订阅者。
    entry.unsubscribe = session.subscribe((event) => this.publish(entry, event));
    this.entries.set(session.sessionId, entry);
    // 触发 session_start：SDK 只在 CLI 的 interactive/print/rpc mode 里调用
    // bindExtensions()，直接 createAgentSession() 不会发该事件。此处补上，
    // 否则 Plan 等依赖 session_start 做初始化的内联扩展会完全失效。
    // 失败不阻断会话可用性（扩展是增量能力，不该让会话建不起来）。
    try {
      await session.bindExtensions?.({});
    } catch (error) {
      this.logger?.warn(
        { sessionId: session.sessionId, error: messageOf(error) },
        'session_start dispatch failed',
      );
    }
    return entry;
  }

  /** 直接取活跃条目（不打开、不恢复）。 */
  get(sessionId: string): RegistryEntry | undefined {
    return this.entries.get(sessionId);
  }

  /** 列出所有活跃会话（按创建时间倒序）。 */
  list(): Array<{ id: string; cwd: string; createdAt: Date; session: PiSession }> {
    return [...this.entries.values()]
      .map((entry) => ({
        id: entry.session.sessionId,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        session: entry.session,
      }))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  /** 为活跃会话构造一个"兜底"的持久化信息（可能还没写盘）。 */
  private activeInfo(entry: RegistryEntry): PersistedSessionInfo {
    return {
      id: entry.session.sessionId,
      path: entry.session.sessionManager?.getSessionFile() ?? '',
      cwd: entry.cwd,
      name: undefined,
      parentSessionPath: undefined,
      created: entry.createdAt,
      modified: entry.createdAt,
      messageCount: entry.session.messages.length,
      firstMessage: '',
    };
  }

  /**
   * 订阅会话事件流（SSE 用）。
   * 中文说明：先重放 afterEventId 之后的历史事件（断线重连），
   * 再把 listener 加入订阅集合接收后续实时事件；返回取消订阅函数。
   */
  subscribe(
    sessionId: string,
    afterEventId: number,
    listener: (event: StreamEvent) => void,
  ): () => void {
    const entry = this.require(sessionId);
    // 重放合并：缓存里同一段流式输出会有几百条 message_update，逐条补发等于让客户端
    // 一建连就重渲染几百次（长回复会把主线程压满，见 docs/web-stream-coalescing.md）。
    // 只发每段连续 message_update 的最后一条；事件 id 仍单调递增，Last-Event-ID 语义不变。
    const replay = entry.events.filter((event) => event.id > afterEventId);
    for (let index = 0; index < replay.length; index += 1) {
      const event = replay[index]!;
      if (
        isMessageUpdatePayload(event.payload) &&
        isMessageUpdatePayload(replay[index + 1]?.payload)
      ) {
        continue;
      }
      listener(event);
    }
    entry.subscribers.add(listener);
    return () => entry.subscribers.delete(listener);
  }

  /**
   * 向会话下发命令（POST /api/agent/:sessionId 的底层实现）。
   * 中文说明：这是"协议翻译层"——把前端传来的 { type: "prompt" | "abort" |
   * "set_model" | ... } 翻译成 PiSession 的具体方法调用。
   */
  async command(
    sessionId: string,
    command: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const session = (await this.open(sessionId)).session;
    const message = typeof command.message === 'string' ? command.message : '';
    const images = this.images(command.images);
    switch (command.type) {
      case 'prompt': {
        // `mode: 'plan'` 表示「这条消息进入规划」——一次性、消息级属性，
        // 而不是 M4 之前的会话级预开关：因此必须先建/采纳计划，
        // 模型随后拿到的 before_agent_start 上下文才是规划期的。
        if (command.mode === 'plan') {
          this.requirePlans().startPlanning(sessionId, message);
        } else if (command.mode !== undefined && command.mode !== 'direct') {
          throw new ApiError(422, 'validation_error', 'mode must be "direct" or "plan"');
        }
        // prompt 是异步长任务（模型思考+输出可能很久）：不 await，
        // 启动后立刻返回，结果通过 SSE 事件流推送（见 start() 的说明）。
        this.start(
          session.prompt(message, images.length === 0 ? undefined : { images }),
          sessionId,
        );
        return {};
      }
      case 'steer': // 干预：打断当前输出并插入新指令
        await session.steer(message, images);
        return {};
      case 'follow_up': // 追加追问（不打断当前输出）
        await session.followUp(message, images);
        return {};
      case 'abort':
        await this.abortSession(sessionId, session);
        return {};
      case 'set_model': {
        const provider = this.requiredString(command.provider, 'provider');
        const modelId = this.requiredString(command.modelId, 'modelId');
        const model = session.modelRuntime.getModel(provider, modelId);
        if (model === undefined) {
          throw new ApiError(400, 'model_not_found', `Unknown Pi model: ${provider}/${modelId}`);
        }
        await session.setModel(model);
        return {};
      }
      case 'set_thinking_level':
        session.setThinkingLevel(this.requiredString(command.thinkingLevel, 'thinkingLevel'));
        return {};
      case 'set_tools': {
        const toolNames = command.toolNames;
        if (!Array.isArray(toolNames) || toolNames.some((name) => typeof name !== 'string')) {
          throw new ApiError(422, 'validation_error', 'toolNames must be an array of strings');
        }
        session.setActiveToolsByName(toolNames);
        return {};
      }
      case 'compact': // 手动压缩上下文（把早期消息归纳成摘要）
        await session.compact(
          typeof command.customInstructions === 'string' ? command.customInstructions : undefined,
        );
        return {};
      case 'navigate_tree': // 在消息树中跳转到某条消息
        await session.navigateTree(this.requiredString(command.targetId, 'targetId'));
        return {};
      case 'reload_resources': // 重新加载工具/技能
        await session.reload();
        return {};
      case 'answer_question': {
        // 前端对「向用户提问」的回答（M4.1）
        const questionId = this.requiredString(command.questionId, 'questionId');
        if (!this.questions)
          throw new ApiError(409, 'question_unavailable', 'Question channel is unavailable');
        const rawAnswers = command.answers;
        if (rawAnswers !== undefined && !Array.isArray(rawAnswers)) {
          throw new ApiError(422, 'validation_error', 'answers must be an array');
        }
        if (command.cancelled !== undefined && typeof command.cancelled !== 'boolean') {
          throw new ApiError(422, 'validation_error', 'cancelled must be a boolean');
        }
        this.questions.answer(sessionId, questionId, {
          ...(rawAnswers === undefined
            ? {}
            : { answers: rawAnswers as { id: string; selected: string[]; text?: string }[] }),
          ...(command.cancelled === true ? { cancelled: true } : {}),
        });
        return {};
      }
      case 'approve_tool': {
        // 前端对工具调用的审批结果
        const toolCallId = this.requiredString(command.toolCallId, 'toolCallId');
        if (typeof command.approved !== 'boolean') {
          throw new ApiError(422, 'validation_error', 'approved must be a boolean');
        }
        this.approveTool(sessionId, toolCallId, command.approved);
        return {};
      }
      case 'plan_start':
      case 'plan_execute':
      case 'plan_pause':
      case 'plan_resume':
      case 'plan_refine':
      case 'plan_abandon': {
        const action = command.type.replace('plan_', '') as
          'start' | 'execute' | 'pause' | 'resume' | 'refine' | 'abandon';
        const plan = await this.requirePlans().command(
          sessionId,
          action,
          typeof command.message === 'string' ? command.message : undefined,
        );
        // 暂停要真的停手：改状态之后立刻中止当前轮，否则模型会继续跑完。
        if (action === 'pause' || action === 'abandon')
          await this.abortSession(sessionId, session, '计划已暂停或放弃');
        return { plan };
      }
      case 'plan_enable': // 兼容旧客户端：等价于「用这条消息开始规划」
      case 'plan_disable': {
        // 兼容旧客户端：等价于放弃计划
        this.logger?.warn(
          { sessionId, type: command.type },
          'deprecated plan command received (use plan_start / plan_abandon)',
        );
        const plan = await this.requirePlans().command(
          sessionId,
          command.type === 'plan_enable' ? 'start' : 'abandon',
          typeof command.message === 'string' ? command.message : undefined,
        );
        if (command.type === 'plan_disable')
          await this.abortSession(sessionId, session, '计划已放弃');
        return { plan };
      }
      default:
        throw new ApiError(
          422,
          'unsupported_command',
          `Unsupported Node Pi command: ${String(command.type)}`,
        );
    }
  }

  /** 会话当前状态快照（GET /api/agent/:sessionId 的返回体）。 */
  state(sessionId: string): Record<string, unknown> | undefined {
    const entry = this.get(sessionId);
    if (entry === undefined) return undefined;
    const { session } = entry;
    const pending = this.approvals?.pendingForSession(sessionId);
    return {
      sessionId,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isSummarizingBranch: false, // Node 后端暂不支持分支摘要，固定 false 与 Python 端对齐
      isRetrying: session.retryAttempt > 0,
      retryAttempt: session.retryAttempt,
      thinkingLevel: session.thinkingLevel,
      model:
        session.model === undefined
          ? null
          : { provider: session.model.provider, modelId: session.model.id },
      activeTools: session.getActiveToolNames(),
      // 零成本修复：SDK 已经算好这两项（M0 实测返回 {tokens, contextWindow, percent}），
      // 之前被硬编码成 null/{}，导致前端上下文仪表盘长期为空。
      // 保持与 Python 后端字段兼容：能力不存在时仍返回 null / {}。
      contextUsage: session.getContextUsage?.() ?? null,
      sessionStats: (session.getSessionStats?.() ?? {}) as Record<string, unknown>,
      pendingQuestion: this.questions?.pendingForSession(sessionId) ?? null,
      pendingToolCall:
        pending === undefined
          ? null
          : {
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              reason: pending.reason,
              rule: pending.rule,
              args: pending.args,
              risk: pending.risk,
              category: pending.category,
            },
      plan: this.planState(sessionId),
    };
  }

  /** 关闭注册表：释放所有活跃会话（服务关闭钩子调用）。 */
  async close(): Promise<void> {
    // 子任务先停：它们的父会话马上要被 dispose，留着就是没有归属的孤儿。
    this.subagents?.abortAllSessions('服务已关闭');
    for (const entry of this.entries.values()) {
      entry.unsubscribe();
      entry.subscribers.clear();
      if (entry.session.isStreaming) await entry.session.abort(); // 先停流式输出
      this.approvals?.cancelSession(entry.session.sessionId); // 拒绝所有待审批
      this.questions?.cancelSession(entry.session.sessionId); // 未回答的提问按「会话结束」结算
      // 未结算的 run 按 aborted 收尾，否则库里会留下永远 running 的记录。
      this.ledger?.finalizeSession(entry.session.sessionId, 'aborted');
      entry.session.dispose(); // 释放 SDK 资源
    }
    this.approvals?.dispose(); // 退订事件总线
    this.questions?.dispose(); // 不能让提问的 Promise 永远挂着
    this.entries.clear();
  }

  /** 让所有活跃会话重新加载资源（技能开关改动后调用）。 */
  async reloadResources(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.session.reload()));
  }

  /** 从注册表移除会话（删除会话时调用）：先停输出、清订阅、再释放。 */
  async remove(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    // 会话被移除（删除会话 / 子会话收尾）时，级联停掉它派出去的子任务。
    this.subagents?.abortAll(sessionId, '会话已关闭');
    entry.unsubscribe();
    entry.subscribers.clear();
    this.approvals?.cancelSession(sessionId);
    this.plans?.remove(sessionId);
    this.ledger?.finalizeSession(sessionId, 'aborted');
    if (entry.session.isStreaming) await entry.session.abort();
    entry.session.dispose();
    this.entries.delete(sessionId);
  }

  /**
   * 同步内存上下文：合并/压缩等操作修改了持久化的上下文后，
   * 把内存里 agent 的状态消息同步成最新上下文，让模型立即感知。
   */
  syncContext(sessionId: string): void {
    const entry = this.require(sessionId);
    const context = entry.session.sessionManager?.buildSessionContext();
    // 通过 duck-typing 取到 SDK 内部的 agent.state.messages（SDK 未公开该类型）。
    const agent = (entry.session as unknown as { agent?: { state?: { messages: unknown[] } } })
      .agent;
    if (context && agent?.state) agent.state.messages = context.messages;
  }

  /** 让会话工厂重载模型运行时（models.json 修改后调用）。 */
  reloadModelRuntime(): void {
    this.sessionFactory.reloadModelRuntime?.();
  }

  /**
   * 记录会话当前执行的任务（任务在会话里被创建/绑定时调用）。
   * 中文说明：只影响**之后**开始的 run——账本在 run 开始时落 task_id。传 null 表示解绑。
   */
  setActiveTask(sessionId: string, taskId: string | null): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (taskId === null) delete entry.activeTaskId;
    else entry.activeTaskId = taskId;
  }

  /** 把任务变更广播给相关会话（SSE `task_updated`）。
   *
   * 中文说明：本服务的 SSE 通道是**按会话**的，没有全局流，所以路由规则必须写清楚：
   * - 任务绑定了 sessionId → 只推给该会话；
   * - 没有绑定 → 推给所有 cwd 匹配（或任务未指定 cwd）的活跃会话。
   * 未打开的会话不会收到推送，但它们重新打开时面板会通过 REST 拉到最新状态。
   */
  announceTask(task: TaskRecord): void {
    const payload = { type: 'task_updated' as const, task };
    if (task.sessionId !== undefined) {
      const entry = this.entries.get(task.sessionId);
      if (entry) this.publish(entry, payload);
      return;
    }
    for (const entry of this.entries.values()) {
      if (task.cwd === undefined || entry.cwd === task.cwd) this.publish(entry, payload);
    }
  }

  /**
   * 向一个会话补推「有任务需要恢复」（SSE `task_recovery_required`）。
   * 中文说明：走注册表的 publish 而不是直接写 SSE 帧，这样事件有正确的递增 id
   * 并进入重放缓存（断线重连不会丢）。没有待恢复任务时不发（不发空事件）。
   */
  announceRecovery(sessionId: string, items: TaskRecoveryItem[]): void {
    if (items.length === 0) return;
    const entry = this.entries.get(sessionId);
    if (entry) this.publish(entry, { type: 'task_recovery_required', tasks: items });
  }

  /** 该会话当前是否有 SSE 订阅者（用来判断“是不是首个连接”）。 */
  hasSubscribers(sessionId: string): boolean {
    return (this.entries.get(sessionId)?.subscribers.size ?? 0) > 0;
  }

  /** 把审批结果交给审批中枢（挂起的 bash 工具调用会据此放行/拦截）。 */
  approveTool(sessionId: string, toolCallId: string, approved: boolean): void {
    if (!this.approvals)
      throw new ApiError(
        409,
        'approval_unavailable',
        'Tool approval is unavailable for this session',
      );
    this.approvals.decide(sessionId, toolCallId, approved);
  }

  /** 会话当前计划视图（M4：PlanView，来自任务库；无计划时 `planId` 为空串）。 */
  planState(sessionId: string): PlanView {
    return this.plans?.state(sessionId) ?? emptyPlanView(sessionId);
  }

  /** 取 Plan 服务（未装配时 409，避免散落的 `if (!this.plans)`）。 */
  private requirePlans(): PlanModeService {
    if (!this.plans)
      throw new ApiError(409, 'plan_unavailable', 'Plan mode is unavailable for this session');
    return this.plans;
  }

  /**
   * 中止会话的当前轮，并级联停掉它派出去的子任务（M5）。
   * 中文说明：单独抽出来是因为「停手」有四个入口（abort 命令、计划暂停/放弃、
   * 兼容命令 plan_disable），漏掉任何一个都会留下还在跑的子会话。
   */
  private async abortSession(
    sessionId: string,
    session: PiSession,
    reason = '父会话已中止',
  ): Promise<void> {
    await session.abort();
    this.subagents?.abortAll(sessionId, reason);
  }

  /** 取活跃条目，不存在抛 404（区别于 open 的自动恢复语义）。 */
  private require(sessionId: string): RegistryEntry {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      throw new ApiError(404, 'agent_not_active', `Agent ${sessionId} is not active`);
    }
    return entry;
  }

  /**
   * 启动一个"后台异步操作"并吞掉错误。
   * 中文说明：prompt() 这类长任务不阻塞 HTTP 响应；其 reject（比如模型报错）
   * 不会变成未处理的 Promise 拒绝导致进程崩溃——错误会以 agent_end 事件
   * 的形式通过事件流告知前端（由 SDK 内部发出）。
   * 失败同时上报账本：prompt() 在校验阶段就 reject 时不会触发任何 agent 事件，
   * 若不在这里上报，这类失败在 trace 里完全不可见。
   */
  private start(operation: Promise<void>, sessionId: string): void {
    void operation.catch((error: unknown) => {
      const entry = this.entries.get(sessionId);
      if (entry) this.ledger?.noteCommandFailure(this.ledgerContext(entry), error);
    });
  }

  /** 命令参数必须是"非空字符串"，否则 422。 */
  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value) {
      throw new ApiError(422, 'validation_error', `${field} must be a non-empty string`);
    }
    return value;
  }

  /** 校验命令里的图片附件结构（宽松版，路由层已做过严格版）。 */
  private images(value: unknown): ImageAttachment[] {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.some(
        (image) =>
          image === null ||
          typeof image !== 'object' ||
          (image as ImageAttachment).type !== 'image' ||
          typeof (image as ImageAttachment).data !== 'string' ||
          typeof (image as ImageAttachment).mimeType !== 'string',
      )
    ) {
      throw new ApiError(422, 'validation_error', 'images must be image content blocks');
    }
    return value as ImageAttachment[];
  }

  /**
   * 事件发布核心：SDK 事件 → 编号 → 入缓存（超限丢最旧）→ 广播给所有订阅者。
   */
  private publish(entry: RegistryEntry, payload: StreamEvent['payload']): void {
    this.logSessionEvent(entry, payload);
    // 可观测性插桩点（唯一）：账本自身吞掉所有异常，不会影响事件分发。
    this.ledger?.record(this.ledgerContext(entry), payload);
    const event: StreamEvent = { id: entry.nextEventId++, payload };
    entry.events.push(event);
    if (entry.events.length > MAX_REPLAY_EVENTS) entry.events.shift();
    for (const subscriber of entry.subscribers) subscriber(event);
  }

  /** 给账本的会话上下文（只取记账需要的字段，不让账本依赖注册表内部结构）。 */
  private ledgerContext(entry: RegistryEntry): LedgerSessionContext {
    const { session } = entry;
    return {
      sessionId: session.sessionId,
      cwd: entry.cwd,
      ...(session.model ? { provider: session.model.provider, model: session.model.id } : {}),
      thinkingLevel: session.thinkingLevel,
      ...(entry.activeTaskId === undefined ? {} : { taskId: entry.activeTaskId }),
      // 子会话的 run 挂到父 run 下（M5）：M1 建表时已留 parent_run_id 列，无需迁移。
      ...(entry.subagent?.parentRunId === undefined
        ? {}
        : { parentRunId: entry.subagent.parentRunId }),
      ...(entry.subagent === undefined
        ? {}
        : {
            parentSessionId: entry.subagent.parentSessionId,
            subagentPreset: entry.subagent.preset,
            subagentDepth: entry.subagent.depth,
          }),
    };
  }

  /**
   * 把关键 SDK 事件写入日志（请求日志之外的补充观测点）。
   * 中文说明：覆盖三类信息——工具执行（开始/结束+耗时）、模型请求（turn_start）
   * 与模型响应（message_end：provider/model、stopReason、token 用量与耗时）。
   * 响应报错时升级为 error 级别。只记元数据，不落正文，避免日志体积与敏感内容问题。
   */
  private logSessionEvent(entry: RegistryEntry, event: StreamEvent['payload']): void {
    const logger = this.logger;
    if (!logger) return;
    const sessionId = entry.session.sessionId;
    switch (event.type) {
      case 'turn_start': {
        entry.turnStartedAt = Date.now();
        logger.info(
          {
            sessionId,
            model: entry.session.model
              ? `${entry.session.model.provider}/${entry.session.model.id}`
              : undefined,
            thinkingLevel: entry.session.thinkingLevel,
            messages: entry.session.messages.length,
          },
          'model request',
        );
        break;
      }
      case 'message_end': {
        // message_end 也可能来自 user/toolResult 消息回放；只统计 assistant（模型响应）。
        if (event.message.role !== 'assistant') break;
        const message = event.message as unknown as AssistantMessageMeta;
        const isError = message.stopReason === 'error';
        const logPayload = {
          sessionId,
          provider: message.provider,
          model: message.model,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
          durationMs:
            entry.turnStartedAt !== undefined ? Date.now() - entry.turnStartedAt : undefined,
          usage: message.usage
            ? {
                input: message.usage.input,
                output: message.usage.output,
                cacheRead: message.usage.cacheRead,
                totalTokens: message.usage.totalTokens,
                costTotal: message.usage.cost?.total,
              }
            : undefined,
        };
        delete entry.turnStartedAt;
        if (isError) logger.error(logPayload, 'model response failed');
        else if (message.stopReason === 'aborted')
          logger.warn(logPayload, 'model response aborted');
        else logger.info(logPayload, 'model response');
        break;
      }
      case 'tool_execution_start': {
        entry.toolStartTimes.set(event.toolCallId, Date.now());
        logger.info(
          {
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: previewOf(event.args),
          },
          'tool execution started',
        );
        break;
      }
      case 'tool_execution_end': {
        const startedAt = entry.toolStartTimes.get(event.toolCallId) ?? Date.now();
        entry.toolStartTimes.delete(event.toolCallId);
        const logPayload = {
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          durationMs: Date.now() - startedAt,
          result: previewOf(event.result),
        };
        if (event.isError) logger.error(logPayload, 'tool execution failed');
        else logger.info(logPayload, 'tool execution finished');
        break;
      }
      default:
        break;
    }
  }

  /**
   * 工具审批待处理时发布 tool_call_pending 事件（驱动前端审批对话框）。
   *
   * 中文说明：子会话的审批**挂到父会话的流上**——用户看的是父会话，弹窗也只在那里；
   * 若子会话自己也有订阅者（有人直接打开了它），则两边都发，避免那个界面看不到。
   * 父会话不在活跃列表里时退回自己的流（总比丢掉好）。
   */
  private announceApproval(pending: PendingToolApproval): void {
    const owner = this.entries.get(pending.sessionId);
    const parent =
      pending.parentSessionId === undefined ? undefined : this.entries.get(pending.parentSessionId);
    const payload: StreamEvent['payload'] = {
      type: 'tool_call_pending',
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      args: pending.args,
      reason: pending.reason,
      rule: pending.rule,
      risk: pending.risk,
      category: pending.category,
      ...(parent === undefined
        ? {}
        : {
            sessionId: pending.sessionId,
            parentSessionId: pending.parentSessionId as string,
            ...(pending.agent === undefined ? {} : { agent: pending.agent }),
          }),
    };
    if (parent !== undefined) {
      this.publish(parent, payload);
      if (owner !== undefined && owner !== parent && owner.subscribers.size > 0)
        this.publish(owner, payload);
      return;
    }
    if (owner !== undefined) this.publish(owner, payload);
  }

  private announceQuestion(question: PendingQuestion): void {
    const entry = this.entries.get(question.sessionId);
    if (entry) this.publish(entry, { type: 'question_pending', question });
  }

  private announceQuestionResolved(sessionId: string, questionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) this.publish(entry, { type: 'question_resolved', questionId });
  }

  private announcePlan(plan: PlanView): void {
    const entry = this.entries.get(plan.sessionId);
    if (entry) this.publish(entry, { type: 'plan_updated', plan });
  }
}

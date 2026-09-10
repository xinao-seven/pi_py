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
import { PlanModeService, type PlanSnapshot } from './plan-mode-service.js';
import { SessionLedger, type LedgerSessionContext } from './observability/session-ledger.js';
import { buildMcpExtension } from './mcp/mcp-extension.js';
import type { McpService } from './mcp/mcp-service.js';

/** 每个会话内存中最多缓存的 SSE 事件条数（超出后丢弃最旧的）。 */
const MAX_REPLAY_EVENTS = 256;

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
export const INLINE_OWNED_EXTENSION_DIRS = ['plan-mode'] as const;

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
  };
  /** MCP 服务白名单；null/缺省 = 全部，[] = 禁用，非空数组 = 服务名白名单（预设的 mcpServers 字段）。 */
  mcpServers?: string[] | null;
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
    | { type: 'plan_updated'; plan: PlanSnapshot }
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
}

/**
 * SDK 适配器：凭据与模型元数据仍由原版 Pi 文件（auth.json / models.json）管理，
 * 本类只负责把它们组装成 createAgentSession 需要的依赖。
 */
export class OriginalPiSessionFactory implements PiSessionFactory {
  /** ModelRuntime 是重量级对象（要读文件、可能起子进程），做单例缓存。 */
  private runtimePromise: Promise<ModelRuntime> | undefined;

  constructor(
    private readonly agentDir: string,
    private readonly mcpService?: McpService,
    private readonly approvals?: ToolApprovalBroker,
    private readonly plans?: PlanModeService,
    private readonly logger?: ServiceLogger,
    /** 可观测性扩展：把 provider 层 HTTP 观测接入每个会话（可选）。 */
    private readonly observability?: { buildExtension(): InlineExtension },
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
      ),
      ...(model === undefined ? {} : { model }),
      ...(input.thinkingLevel
        ? { thinkingLevel: input.thinkingLevel as AgentSession['thinkingLevel'] }
        : {}),
      ...(input.toolNames === undefined ? {} : { tools: input.toolNames }),
      ...(settingsManager === undefined ? {} : { settingsManager }),
    });
    // createAgentSession 返回 { session, agent, ... }，这里只把 session 暴露出去。
    return session.session as unknown as PiSession;
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

  /** 惰性创建并缓存 ModelRuntime（并发调用共享同一个实例）。 */
  private getRuntime(): Promise<ModelRuntime> {
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
  ) {
    // 工具审批待处理时，通过注册表发布一条 tool_call_pending 事件（SSE 推给前端）。
    approvals?.setPendingListener((pending) => this.announceApproval(pending));
    plans?.setListener((plan) => this.announcePlan(plan));
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
    return this.register(session, input.cwd, new Date());
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
    };
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
    for (const event of entry.events) {
      if (event.id > afterEventId) listener(event);
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
      case 'prompt':
        // prompt 是异步长任务（模型思考+输出可能很久）：不 await，
        // 启动后立刻返回，结果通过 SSE 事件流推送（见 start() 的说明）。
        this.start(
          session.prompt(message, images.length === 0 ? undefined : { images }),
          sessionId,
        );
        return {};
      case 'steer': // 干预：打断当前输出并插入新指令
        await session.steer(message, images);
        return {};
      case 'follow_up': // 追加追问（不打断当前输出）
        await session.followUp(message, images);
        return {};
      case 'abort':
        await session.abort();
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
      case 'approve_tool': {
        // 前端对工具调用的审批结果
        const toolCallId = this.requiredString(command.toolCallId, 'toolCallId');
        if (typeof command.approved !== 'boolean') {
          throw new ApiError(422, 'validation_error', 'approved must be a boolean');
        }
        this.approveTool(sessionId, toolCallId, command.approved);
        return {};
      }
      case 'plan_enable':
      case 'plan_disable':
      case 'plan_execute':
      case 'plan_refine': {
        if (!this.plans)
          throw new ApiError(409, 'plan_unavailable', 'Plan mode is unavailable for this session');
        const action = command.type.replace('plan_', '') as
          'enable' | 'disable' | 'execute' | 'refine';
        this.plans.command(
          sessionId,
          action,
          typeof command.message === 'string' ? command.message : undefined,
        );
        return {};
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
    for (const entry of this.entries.values()) {
      entry.unsubscribe();
      entry.subscribers.clear();
      if (entry.session.isStreaming) await entry.session.abort(); // 先停流式输出
      this.approvals?.cancelSession(entry.session.sessionId); // 拒绝所有待审批
      // 未结算的 run 按 aborted 收尾，否则库里会留下永远 running 的记录。
      this.ledger?.finalizeSession(entry.session.sessionId, 'aborted');
      entry.session.dispose(); // 释放 SDK 资源
    }
    this.approvals?.dispose(); // 退订事件总线
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

  planState(sessionId: string): PlanSnapshot {
    return (
      this.plans?.state(sessionId) ?? {
        sessionId,
        mode: 'normal',
        todos: [],
        awaitingConfirmation: false,
      }
    );
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

  /** 工具审批待处理时发布 tool_call_pending 事件（驱动前端审批对话框）。 */
  private announceApproval(pending: PendingToolApproval): void {
    const entry = this.entries.get(pending.sessionId);
    if (!entry) return;
    this.publish(entry, {
      type: 'tool_call_pending',
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      args: pending.args,
      reason: pending.reason,
      rule: pending.rule,
      risk: pending.risk,
      category: pending.category,
    });
  }

  private announcePlan(plan: PlanSnapshot): void {
    const entry = this.entries.get(plan.sessionId);
    if (entry) this.publish(entry, { type: 'plan_updated', plan });
  }
}

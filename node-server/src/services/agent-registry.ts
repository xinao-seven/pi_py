/** Original Pi session registry and event replay buffer.
 *
 * 中文说明：一个会话只保留一个活跃的原版 Pi AgentSession。SDK 事件被原样缓存，
 * 由 SSE 路由推送给现有 Vue 前端；注册表不依赖 Fastify，便于单元测试。
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { ApiError } from "../errors.js";
import { createApprovalExtension, ToolApprovalBroker, type PendingToolApproval } from "./tool-approval.js";

const MAX_REPLAY_EVENTS = 256;

export interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

export interface CreateSessionInput {
  cwd: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
}

export interface PersistedSessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

export interface OpenSessionInput extends PersistedSessionInfo {}

export interface PiSession {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly thinkingLevel: string;
  readonly model: { provider: string; id: string } | undefined;
  readonly messages: unknown[];
  readonly isCompacting: boolean;
  readonly retryAttempt: number;
  readonly modelRuntime: {
    getModel(provider: string, modelId: string): { provider: string; id: string } | undefined;
  };
  readonly sessionManager?: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    getLeafId(): string | null;
    getTree(): unknown[];
    buildContextEntries(): unknown[];
    buildSessionContext(): { messages: unknown[]; thinkingLevel: string; model: { provider: string; modelId: string } | null };
  };
  getActiveToolNames(): string[];
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
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
  dispose(): void;
}

export interface PiSessionFactory {
  create(input: CreateSessionInput): Promise<PiSession>;
  listPersistedSessions?(): Promise<PersistedSessionInfo[]>;
  open?(input: OpenSessionInput): Promise<PiSession>;
  reloadModelRuntime?(): void;
}

export interface StreamEvent {
  id: number;
  payload: AgentSessionEvent | { type: "agent_end"; error: string } | { type: "tool_call_pending"; toolCallId: string; toolName: string; args: Record<string, unknown>; reason: string; rule: string };
}

export interface RegistryEntry {
  session: PiSession;
  cwd: string;
  createdAt: Date;
  events: StreamEvent[];
  nextEventId: number;
  unsubscribe: () => void;
  subscribers: Set<(event: StreamEvent) => void>;
  persisted?: PersistedSessionInfo;
}

/** SDK adapter: credentials and model metadata remain managed by original Pi files. */
export class OriginalPiSessionFactory implements PiSessionFactory {
  private runtimePromise: Promise<ModelRuntime> | undefined;

  constructor(private readonly agentDir: string, private readonly approvals: ToolApprovalBroker) {}

  async create(input: CreateSessionInput): Promise<PiSession> {
    if ((input.provider === undefined) !== (input.modelId === undefined)) {
      throw new ApiError(422, "invalid_model", "provider and modelId must be provided together");
    }
    const runtime = await this.getRuntime();
    const model = input.provider && input.modelId
      ? runtime.getModel(input.provider, input.modelId)
      : undefined;
    if (input.provider && input.modelId && model === undefined) {
      throw new ApiError(400, "model_not_found", `Unknown Pi model: ${input.provider}/${input.modelId}`);
    }
    const session = await createAgentSession({
      cwd: input.cwd,
      agentDir: this.agentDir,
      modelRuntime: runtime,
      resourceLoader: await this.loader(input.cwd),
      ...(model === undefined ? {} : { model }),
      ...(input.thinkingLevel && input.thinkingLevel !== "off"
        ? { thinkingLevel: input.thinkingLevel as AgentSession["thinkingLevel"] }
        : {}),
      ...(input.toolNames === undefined ? {} : { tools: input.toolNames }),
    });
    return session.session as unknown as PiSession;
  }

  async listPersistedSessions(): Promise<PersistedSessionInfo[]> {
    const sessionsDir = join(this.agentDir, "sessions");
    // Pi stores JSONL files one level below sessions/, grouped by encoded cwd.
    // SessionManager.listAll(customDir) intentionally reads only the specified
    // directory, so passing sessionsDir directly returns an empty list here.
    let directories: string[];
    try {
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      directories = [sessionsDir, ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsDir, entry.name))];
    } catch {
      return [];
    }
    const groups = await Promise.all(directories.map(async (directory) => {
      try {
        return await SessionManager.listAll(directory);
      } catch {
        return [];
      }
    }));
    const unique = new Map(groups.flat().map((session) => [session.id, session]));
    return [...unique.values()].map((session) => this.persistedInfo(session));
  }

  async open(input: OpenSessionInput): Promise<PiSession> {
    const runtime = await this.getRuntime();
    const sessionManager = SessionManager.open(input.path);
    const { session } = await createAgentSession({
      cwd: sessionManager.getCwd() || input.cwd,
      agentDir: this.agentDir,
      modelRuntime: runtime,
      sessionManager,
      resourceLoader: await this.loader(sessionManager.getCwd() || input.cwd),
    });
    return session as unknown as PiSession;
  }

  reloadModelRuntime(): void { this.runtimePromise = undefined; }

  private getRuntime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
      allowModelNetwork: false,
    });
    return this.runtimePromise;
  }

  private async loader(cwd: string): Promise<DefaultResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      // The Web backend cannot render Pi's terminal confirmation UI.  More
      // importantly, a user-level extension can block a tool call before our
      // broker publishes the SSE event that drives ToolApprovalDialog.  Keep
      // extension discovery off and register only the bridge owned by this UI.
      noExtensions: true,
      extensionFactories: [{ name: "node-tool-approval", factory: createApprovalExtension(this.approvals), hidden: true }],
    });
    await loader.reload();
    return loader;
  }

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

export class AgentRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly opening = new Map<string, Promise<RegistryEntry>>();

  constructor(private readonly sessionFactory: PiSessionFactory, private readonly approvals?: ToolApprovalBroker) {
    approvals?.setPendingListener((pending) => this.announceApproval(pending));
  }

  async create(input: CreateSessionInput): Promise<RegistryEntry> {
    const session = await this.sessionFactory.create(input);
    const existing = this.entries.get(session.sessionId);
    if (existing !== undefined) {
      throw new ApiError(409, "session_active", `Session ${session.sessionId} is already active`);
    }
    return this.register(session, input.cwd, new Date());
  }

  async open(sessionId: string): Promise<RegistryEntry> {
    const active = this.entries.get(sessionId);
    if (active !== undefined) return active;
    const pending = this.opening.get(sessionId);
    if (pending !== undefined) return pending;
    if (!this.sessionFactory.listPersistedSessions || !this.sessionFactory.open) {
      throw new ApiError(404, "session_not_found", `Session ${sessionId} was not found`);
    }
    const operation = this.openPersisted(sessionId);
    this.opening.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      this.opening.delete(sessionId);
    }
  }

  async listSessions(): Promise<Array<PersistedSessionInfo & { active: boolean }>> {
    const persisted = this.sessionFactory.listPersistedSessions
      ? await this.sessionFactory.listPersistedSessions()
      : [];
    const byId = new Map(persisted.map((item) => [item.id, { ...item, active: false }]));
    for (const entry of this.entries.values()) {
      const existing = byId.get(entry.session.sessionId);
      byId.set(entry.session.sessionId, {
        ...(existing ?? this.activeInfo(entry)),
        active: true,
      });
    }
    return [...byId.values()].sort((left, right) => right.modified.getTime() - left.modified.getTime());
  }

  private async openPersisted(sessionId: string): Promise<RegistryEntry> {
    const info = (await this.sessionFactory.listPersistedSessions!()).find((item) => item.id === sessionId);
    if (info === undefined) throw new ApiError(404, "session_not_found", `Session ${sessionId} was not found`);
    const session = await this.sessionFactory.open!(info);
    const active = this.entries.get(session.sessionId);
    if (active !== undefined) return active;
    return this.register(session, info.cwd, info.created, info);
  }

  private register(session: PiSession, cwd: string, createdAt: Date, persisted?: PersistedSessionInfo): RegistryEntry {
    if (this.entries.has(session.sessionId)) {
      throw new ApiError(409, "session_active", `Session ${session.sessionId} is already active`);
    }
    const entry: RegistryEntry = {
      session,
      cwd,
      createdAt,
      events: [],
      nextEventId: 1,
      unsubscribe: () => undefined,
      subscribers: new Set(),
      persisted,
    };
    entry.unsubscribe = session.subscribe((event) => this.publish(entry, event));
    this.entries.set(session.sessionId, entry);
    return entry;
  }

  get(sessionId: string): RegistryEntry | undefined {
    return this.entries.get(sessionId);
  }

  list(): Array<{ id: string; cwd: string; createdAt: Date; session: PiSession }> {
    return [...this.entries.values()]
      .map((entry) => ({ id: entry.session.sessionId, cwd: entry.cwd, createdAt: entry.createdAt, session: entry.session }))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  private activeInfo(entry: RegistryEntry): PersistedSessionInfo {
    return {
      id: entry.session.sessionId,
      path: entry.session.sessionManager?.getSessionFile() ?? "",
      cwd: entry.cwd,
      name: undefined,
      parentSessionPath: undefined,
      created: entry.createdAt,
      modified: entry.createdAt,
      messageCount: entry.session.messages.length,
      firstMessage: "",
    };
  }

  subscribe(sessionId: string, afterEventId: number, listener: (event: StreamEvent) => void): () => void {
    const entry = this.require(sessionId);
    for (const event of entry.events) {
      if (event.id > afterEventId) listener(event);
    }
    entry.subscribers.add(listener);
    return () => entry.subscribers.delete(listener);
  }

  async command(sessionId: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = (await this.open(sessionId)).session;
    const message = typeof command.message === "string" ? command.message : "";
    const images = this.images(command.images);
    switch (command.type) {
      case "prompt":
        this.start(session.prompt(message, images.length === 0 ? undefined : { images }));
        return {};
      case "steer":
        await session.steer(message, images);
        return {};
      case "follow_up":
        await session.followUp(message, images);
        return {};
      case "abort":
        await session.abort();
        return {};
      case "set_model": {
        const provider = this.requiredString(command.provider, "provider");
        const modelId = this.requiredString(command.modelId, "modelId");
        const model = session.modelRuntime.getModel(provider, modelId);
        if (model === undefined) {
          throw new ApiError(400, "model_not_found", `Unknown Pi model: ${provider}/${modelId}`);
        }
        await session.setModel(model);
        return {};
      }
      case "set_thinking_level":
        session.setThinkingLevel(this.requiredString(command.thinkingLevel, "thinkingLevel"));
        return {};
      case "set_tools": {
        const toolNames = command.toolNames;
        if (!Array.isArray(toolNames) || toolNames.some((name) => typeof name !== "string")) {
          throw new ApiError(422, "validation_error", "toolNames must be an array of strings");
        }
        session.setActiveToolsByName(toolNames);
        return {};
      }
      case "compact":
        await session.compact(typeof command.customInstructions === "string" ? command.customInstructions : undefined);
        return {};
      case "navigate_tree":
        await session.navigateTree(this.requiredString(command.targetId, "targetId"));
        return {};
      case "reload_resources":
        await session.reload();
        return {};
      case "approve_tool": {
        const toolCallId = this.requiredString(command.toolCallId, "toolCallId");
        if (typeof command.approved !== "boolean") {
          throw new ApiError(422, "validation_error", "approved must be a boolean");
        }
        this.approveTool(sessionId, toolCallId, command.approved);
        return {};
      }
      default:
        throw new ApiError(422, "unsupported_command", `Unsupported Node Pi command: ${String(command.type)}`);
    }
  }

  state(sessionId: string): Record<string, unknown> | undefined {
    const entry = this.get(sessionId);
    if (entry === undefined) return undefined;
    const { session } = entry;
    const pending = this.approvals?.pendingForSession(sessionId);
    return {
      sessionId,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isSummarizingBranch: false,
      isRetrying: session.retryAttempt > 0,
      retryAttempt: session.retryAttempt,
      thinkingLevel: session.thinkingLevel,
      model: session.model === undefined ? null : { provider: session.model.provider, modelId: session.model.id },
      activeTools: session.getActiveToolNames(),
      contextUsage: null,
      sessionStats: {},
      pendingToolCall: pending === undefined ? null : {
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        reason: pending.reason,
        rule: pending.rule,
        args: pending.args,
      },
    };
  }

  async close(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.unsubscribe();
      entry.subscribers.clear();
      if (entry.session.isStreaming) await entry.session.abort();
      this.approvals?.cancelSession(entry.session.sessionId);
      entry.session.dispose();
    }
    this.entries.clear();
  }

  async reloadResources(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.session.reload()));
  }

  async remove(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.unsubscribe();
    entry.subscribers.clear();
    this.approvals?.cancelSession(sessionId);
    if (entry.session.isStreaming) await entry.session.abort();
    entry.session.dispose();
    this.entries.delete(sessionId);
  }

  syncContext(sessionId: string): void {
    const entry = this.require(sessionId);
    const context = entry.session.sessionManager?.buildSessionContext();
    const agent = (entry.session as unknown as { agent?: { state?: { messages: unknown[] } } }).agent;
    if (context && agent?.state) agent.state.messages = context.messages;
  }

  reloadModelRuntime(): void { this.sessionFactory.reloadModelRuntime?.(); }

  approveTool(sessionId: string, toolCallId: string, approved: boolean): void {
    if (!this.approvals) throw new ApiError(409, "approval_unavailable", "Tool approval is unavailable for this session");
    this.approvals.decide(sessionId, toolCallId, approved);
  }

  private require(sessionId: string): RegistryEntry {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      throw new ApiError(404, "agent_not_active", `Agent ${sessionId} is not active`);
    }
    return entry;
  }

  private start(operation: Promise<void>): void {
    void operation.catch(() => undefined);
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value) {
      throw new ApiError(422, "validation_error", `${field} must be a non-empty string`);
    }
    return value;
  }

  private images(value: unknown): ImageAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((image) => (
      image === null
      || typeof image !== "object"
      || (image as ImageAttachment).type !== "image"
      || typeof (image as ImageAttachment).data !== "string"
      || typeof (image as ImageAttachment).mimeType !== "string"
    ))) {
      throw new ApiError(422, "validation_error", "images must be image content blocks");
    }
    return value as ImageAttachment[];
  }

  private publish(entry: RegistryEntry, payload: StreamEvent["payload"]): void {
    const event: StreamEvent = { id: entry.nextEventId++, payload };
    entry.events.push(event);
    if (entry.events.length > MAX_REPLAY_EVENTS) entry.events.shift();
    for (const subscriber of entry.subscribers) subscriber(event);
  }

  private announceApproval(pending: PendingToolApproval): void {
    const entry = this.entries.get(pending.sessionId);
    if (!entry) return;
    this.publish(entry, {
      type: "tool_call_pending",
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      args: pending.args,
      reason: pending.reason,
      rule: pending.rule,
    });
  }
}

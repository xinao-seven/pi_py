// 统一的前端数据类型：与后端 API 的 JSON 结构一一对应。
// 消息角色：用户 / 助手 / 工具结果 / 自定义 / 压缩摘要 / 分支摘要
export type MessageRole =
  'user' | 'assistant' | 'toolResult' | 'custom' | 'compactionSummary' | 'branchSummary';

export interface ContentBlock {
  // 消息内容块：文本、思考、图片或工具调用，按 type 区分
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  data?: string;
  mimeType?: string;
}

export interface AgentMessage {
  // 一条消息：角色 + 内容 + 可选元数据（模型、usage、错误等）
  role: MessageRole;
  content?: string | ContentBlock[];
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface SessionContext {
  // 会话上下文：消息列表 + 每条消息对应的 entryId（SSE 去重用）+ 模型/思考设置
  messages: AgentMessage[];
  entryIds: string[];
  thinkingLevel: string;
  model: ModelRef | null;
}

export interface SessionInfo {
  // 会话列表项元数据（侧栏展示用）
  id: string;
  path: string | null;
  cwd: string;
  name: string | null;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId: string | null;
  parentSessionPath: string | null;
  orphaned?: boolean;
  orphanReason?: string;
}

export interface SessionEntry {
  // 会话树节点：type 为 message/compaction/label 等，parentId 形成树
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: AgentMessage;
  targetId?: string;
  label?: string;
  [key: string]: unknown;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface SessionDetail {
  // 会话详情：元数据 + 树 + 当前叶节点 + 上下文
  sessionId: string;
  filePath: string | null;
  info: SessionInfo;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: SessionContext;
}

export interface ContextUsage {
  // 上下文占用：SDK 在「刚压缩完、下一次响应前」会返回 tokens/percent 为 null（占用未知）
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface AgentState {
  // Agent 运行状态快照
  sessionId: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isSummarizingBranch: boolean;
  isRetrying: boolean;
  retryAttempt: number;
  thinkingLevel: string;
  model: ModelRef;
  activeTools: string[];
  contextUsage: ContextUsage | null;
  sessionStats: Record<string, unknown>;
  pendingToolCall?: PendingToolCall | null;
}

export interface AgentStateResponse {
  running: boolean;
  state?: AgentState;
}

export interface ModelListItem {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

export interface ModelCatalog {
  // 模型目录：模型 id 映射、列表、默认模型与各模型思考档位
  models: Record<string, string>;
  modelList: ModelListItem[];
  defaultModel: ModelRef;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, unknown>>;
}

export interface ModelDefinition {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevels?: string[];
  [key: string]: unknown;
}

export interface ModelProviderConfig {
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: ModelDefinition[];
  [key: string]: unknown;
}

export interface ModelsConfigValue {
  providers: Record<string, ModelProviderConfig>;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  sourceInfo: {
    source: string;
    scope: 'project' | 'user';
    path: string;
    baseDir: string;
  };
  disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
  type: string;
  message: string;
  path: string;
}

export interface SkillsResponse {
  skills: SkillInfo[];
  diagnostics: SkillDiagnostic[];
}

export type McpTransport = 'stdio' | 'streamable-http';
export type McpScope = 'user' | 'workspace';
export type McpServerStatus = 'connected' | 'connecting' | 'error' | 'disabled' | 'idle';

export interface McpServerTool {
  name: string;
  description?: string;
}

export interface McpServerView {
  // MCP server 的 REST 视图：配置 + 实时连接状态 + 工具清单
  name: string;
  scope: McpScope;
  enabled: boolean;
  status: McpServerStatus;
  error?: string;
  toolCount: number;
  tools: McpServerTool[];
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  approval?: 'required';
}

export interface McpServersResponse {
  servers: McpServerView[];
}

export interface McpTestResult {
  success: boolean;
  error?: string;
  toolCount: number;
  tools: McpServerTool[];
}

/** 写入用的 server 配置（POST/PATCH 请求里 server 键的内容）。 */
export interface McpServerConfigInput {
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  approval?: 'required';
}

/** POST/PATCH 请求体：cwd 为工作区，server 为嵌套的配置。 */
export interface McpServerInput {
  name?: string;
  cwd: string;
  scope?: McpScope;
  server: McpServerConfigInput;
}

export interface PresetCompaction {
  // 上下文压缩策略：enabled 开关 + 保留 token 数值
  enabled: boolean;
  keepRecentTokens: number;
  reserveTokens: number;
}

export interface SessionPresetInput {
  // 预设输入（创建/更新用）：空串/缺省 = 用 SDK/设置默认值
  name: string;
  systemPrompt: string; // '' = SDK 默认系统提示词
  toolNames: string[]; // [] = 无工具
  compaction: PresetCompaction;
  provider?: string; // 空串/缺省 = 用目录默认模型
  modelId?: string;
  thinkingLevel?: string; // 空串/缺省 = 用设置默认思考等级
  mcpServers?: string[] | null; // null/缺省 = 全部 MCP 服务；[] = 禁用；非空数组 = 服务名白名单
}

export interface SessionPreset extends SessionPresetInput {
  // 预设视图：含 id 与内置标志
  id: string;
  builtin: boolean;
}

export interface AttachedImage {
  // 待发送的图片：base64 数据 + MIME + 本地预览 URL
  data: string;
  mimeType: string;
  previewUrl: string;
  name: string;
}

export interface AgentEvent {
  // SSE 事件：type 与后端 AgentEvent 一致，其余字段按类型存在
  type: string;
  message?: AgentMessage;
  entryId?: string;
  error?: string | null;
  toolName?: string;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
  reason?: string;
  aborted?: boolean;
  contextUsage?: ContextUsage | null;
  [key: string]: unknown;
}

export type AgentPhase = 'idle' | 'waiting' | 'responding' | 'tool';
// Agent 阶段：空闲 / 等待模型 / 正在生成 / 正在执行工具

export interface PendingToolCall {
  // 等待人工确认的有副作用工具调用（来自 tool_call_pending 事件）
  toolCallId: string;
  toolName: string;
  reason: string;
  rule: string;
  risk: 'medium' | 'high' | 'critical';
  category:
    'workspace_write' | 'dependency_change' | 'network' | 'git_remote' | 'destructive' | 'system';
  args: Record<string, unknown>;
}

export type PlanMode = 'normal' | 'planning' | 'executing';
export interface PlanTodo {
  step: number;
  text: string;
  completed: boolean;
}
export interface PlanSnapshot {
  sessionId: string;
  mode: PlanMode;
  todos: PlanTodo[];
  awaitingConfirmation: boolean;
}

export interface AgentStreamState {
  // 前端简化的流式状态机：运行中、阶段、当前流式消息、错误与待确认工具调用
  running: boolean;
  phase: AgentPhase;
  streamingMessage: AgentMessage | null;
  error: string | null;
  pendingToolCall: PendingToolCall | null;
}

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  errorMessage: string | null;
}

export interface ForkSessionResponse {
  ok: true;
  sessionId: string;
  info: SessionInfo;
}

export interface MergeSessionResponse {
  ok: true;
  entryId: string;
  sourceUniqueEntryCount: number;
  summarizedItemCount: number;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

export interface FileTreeItem extends FileEntry {
  path: string;
}

export interface FileListResponse {
  entries: FileEntry[];
  path: string;
}

export interface FileReadResponse {
  content: string;
  language: string;
  size: number;
}

export interface FileTab {
  // 已打开文件标签
  path: string;
  name: string;
}

// ---- 可观测性（M1：trace / 成本账本）-----------------------------------------

/** trace 存储状态：off＝未开启；degraded＝SQLite 连续写入失败后已丢弃。 */
export interface ObservabilityStoreState {
  mode: 'sqlite' | 'memory' | 'off';
  degraded: boolean;
  pending: number;
  dropped: number;
}

export interface ObservabilitySummary {
  totals: {
    runs: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    p50DurationMs: number;
    p95DurationMs: number;
    p50TtftMs: number;
    errorRate: number;
  };
  byModel: Array<{
    provider: string | null;
    model: string | null;
    runs: number;
    costUsd: number;
    tokens: number;
    p95DurationMs: number;
  }>;
  byTool: Array<{
    toolName: string;
    calls: number;
    errors: number;
    blocked: number;
    errorRate: number;
    p50DurationMs: number;
    p95DurationMs: number;
  }>;
  byApproval: Array<{
    rule: string;
    risk: string;
    approved: number;
    denied: number;
    timedOut: number;
    p50WaitMs: number;
  }>;
  daily: Array<{
    date: string;
    runs: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  store?: ObservabilityStoreState;
}

export type ObservabilityRunStatus = 'running' | 'completed' | 'aborted' | 'error';

export interface ObservabilityRun {
  id: string;
  sessionId: string;
  parentRunId: string | null;
  taskId: string | null;
  cwd: string;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  startedAt: string;
  endedAt: string | null;
  status: ObservabilityRunStatus;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  ttftMs: number | null;
  durationMs: number | null;
  stopReason: string | null;
  errorType: string | null;
  errorMessage: string | null;
  meta: Record<string, unknown> | null;
}

export interface ObservabilityStep {
  kind: 'llm_call' | 'tool_call' | 'approval' | 'compaction' | 'branch_summary' | 'memory_write';
  turnIndex: number;
  toolName: string | null;
  toolCallId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  isError: boolean;
  /** 非空＝被策略拦下（审批拒绝/超时、规划期只读），不算工具失败。 */
  blockedBy: string | null;
  errorType: string | null;
  errorMessage: string | null;
  argsDigest: string | null;
  argsBytes: number | null;
  resultDigest: string | null;
  resultBytes: number | null;
  approvalRule: string | null;
  approvalRisk: string | null;
  approvalDecision: string | null;
  approvalWaitMs: number | null;
  decidedBy: string | null;
  meta: Record<string, unknown> | null;
}

export interface ObservabilityRunDetail {
  run: ObservabilityRun;
  steps: ObservabilityStep[];
  children: ObservabilityRun[];
}

export interface ObservabilityRunList {
  runs: ObservabilityRun[];
  nextCursor: string | null;
}

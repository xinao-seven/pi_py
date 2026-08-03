// 统一的前端数据类型：与后端 API 的 JSON 结构一一对应。
// 消息角色：用户 / 助手 / 工具结果 / 自定义 / 压缩摘要 / 分支摘要
export type MessageRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "custom"
  | "compactionSummary"
  | "branchSummary";

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
  tokens: number;
  contextWindow: number;
  percent: number;
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
    scope: "project" | "user";
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

export type AgentPhase = "idle" | "waiting" | "responding" | "tool";
// Agent 阶段：空闲 / 等待模型 / 正在生成 / 正在执行工具

export interface AgentStreamState {
  // 前端简化的流式状态机：运行中、阶段、当前流式消息与错误
  running: boolean;
  phase: AgentPhase;
  streamingMessage: AgentMessage | null;
  error: string | null;
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

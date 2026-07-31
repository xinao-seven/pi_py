export type MessageRole =
  | "user"
  | "assistant"
  | "toolResult"
  | "custom"
  | "compactionSummary"
  | "branchSummary";

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface AgentMessage {
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
  messages: AgentMessage[];
  entryIds: string[];
  thinkingLevel: string;
  model: ModelRef | null;
}

export interface SessionInfo {
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
}

export interface SessionEntry {
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
  models: Record<string, string>;
  modelList: ModelListItem[];
  defaultModel: ModelRef;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, unknown>>;
}

export interface AgentEvent {
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

export interface AgentStreamState {
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
  path: string;
  name: string;
}

// REST 客户端：封装全部后端 API，统一错误解析（ApiError）。
import { BASE_URL } from './config';
import { appendToken, clearToken, fireUnauthorized, getToken, setToken } from './session';
import type {
  AgentStateResponse,
  FileListResponse,
  FileReadResponse,
  ForkSessionResponse,
  McpScope,
  McpServerInput,
  McpServersResponse,
  McpTestResult,
  MergeSessionResponse,
  ModelCatalog,
  ModelsConfigValue,
  ObservabilityRunDetail,
  ObservabilityRunList,
  ObservabilitySummary,
  PresetCompaction,
  SessionDetail,
  SessionInfo,
  SessionPreset,
  SessionPresetInput,
  SkillsResponse,
  PlanView,
  PromptMode,
  TaskEvidence,
  TaskRecord,
  TaskRecoveryItem,
  TaskStatus,
  TaskStepStatus,
  TaskVerification,
} from '@/types';

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  // 带状态码与机器码的 API 错误
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'request_failed',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 通用请求：自动加 JSON Content-Type；有访问令牌时带 Authorization: Bearer。
  // 非 2xx 时解析后端错误信封并抛 ApiError；鉴权失败（401 unauthorized）通知 auth store。
  const token = getToken();
  const response = await fetch(BASE_URL + path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as T | ErrorEnvelope | null;
  if (!response.ok) {
    const error = (body as ErrorEnvelope | null)?.error;
    const apiError = new ApiError(
      error?.message ?? `请求失败（${response.status}）`,
      response.status,
      error?.code,
      error?.details,
    );
    if (response.status === 401 && error?.code === 'unauthorized') {
      fireUnauthorized();
    }
    throw apiError;
  }
  return body as T;
}

// ---- 访问密码锁 --------------------------------------------------------------

export interface AuthStatus {
  enabled: boolean;
  authenticated?: boolean;
}

/** 登录：校验密码并保存令牌（存 localStorage，刷新保持登录）。 */
export async function login(password: string): Promise<void> {
  const result = await request<{ token: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  setToken(result.token);
}

/** 登出：吊销服务端会话并清除本地令牌。 */
export async function logout(): Promise<void> {
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } finally {
    clearToken();
  }
}

/** 探测密码锁状态：未启用返回 enabled:false；启用后反映当前是否已认证。 */
export function getAuthStatus(): Promise<AuthStatus> {
  return request('/api/auth/status');
}

export async function listSessions(): Promise<SessionInfo[]> {
  // 会话列表
  const result = await request<{ sessions: SessionInfo[] }>('/api/sessions');
  return result.sessions;
}

export function getSession(sessionId: string): Promise<SessionDetail> {
  // 会话详情（含树与上下文）
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function forkSession(sessionId: string, leafId: string): Promise<ForkSessionResponse> {
  // 从指定叶节点 Fork 新会话
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: 'POST',
    body: JSON.stringify({ leafId }),
  });
}

export function mergeSession(
  targetSessionId: string,
  sourceSessionId: string,
): Promise<MergeSessionResponse> {
  return request(`/api/sessions/${encodeURIComponent(targetSessionId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ sourceSessionId }),
  });
}

export function getAgentState(sessionId: string): Promise<AgentStateResponse> {
  return request(`/api/agent/${encodeURIComponent(sessionId)}`);
}

export async function createDefaultWorkspace(): Promise<string> {
  // 创建默认工作区
  const result = await request<{ cwd: string }>('/api/default-cwd', { method: 'POST' });
  return result.cwd;
}

export async function getWorkspaceHome(): Promise<string> {
  const result = await request<{ home: string }>('/api/home');
  return result.home;
}

export async function listWorkspaces(): Promise<string[]> {
  const result = await request<{ workspaces: string[] }>('/api/workspaces');
  return result.workspaces;
}

export async function selectWorkspace(cwd: string): Promise<string> {
  // 登记并选择工作区
  const result = await request<{ cwd: string }>('/api/workspaces/select', {
    method: 'POST',
    body: JSON.stringify({ cwd }),
  });
  return result.cwd;
}

export async function pickWorkspaceDirectory(): Promise<string | undefined> {
  const result = await request<{ cwd: string | null }>('/api/workspaces/pick', { method: 'POST' });
  return result.cwd ?? undefined;
}

export async function createAgent(input: {
  cwd: string;
  message: string;
  /** 执行方式（M4）：direct 默认；plan 让这条消息进入只读规划（新会话也支持）。 */
  mode?: PromptMode;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
  images?: Array<{ type: 'image'; data: string; mimeType: string }>;
  systemPrompt?: string;
  compaction?: PresetCompaction;
  mcpServers?: string[] | null;
}): Promise<string> {
  // 创建新 Agent 会话并发送首条消息，返回 sessionId
  const result = await request<{ success: true; sessionId: string }>('/api/agent/new', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return result.sessionId;
}

export async function sendAgentCommand(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // 向指定会话发送统一命令（prompt/steer/abort/compact 等）
  const result = await request<{ success: true; data: Record<string, unknown> }>(
    `/api/agent/${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      body: JSON.stringify(command),
    },
  );
  return result.data;
}

export function getModels(): Promise<ModelCatalog> {
  return request('/api/models');
}

export function getModelsConfig(): Promise<ModelsConfigValue> {
  return request('/api/models-config');
}

export async function saveModelsConfig(value: ModelsConfigValue): Promise<void> {
  await request('/api/models-config', {
    method: 'PUT',
    body: JSON.stringify(value),
  });
}

export async function getPresets(): Promise<SessionPreset[]> {
  // 全部会话预设（内置 coding-agent + 自定义）
  const result = await request<{ presets: SessionPreset[] }>('/api/presets');
  return result.presets;
}

export async function createPreset(input: SessionPresetInput): Promise<SessionPreset> {
  const result = await request<{ success: true; preset: SessionPreset }>('/api/presets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return result.preset;
}

export async function updatePreset(id: string, input: SessionPresetInput): Promise<SessionPreset> {
  const result = await request<{ success: true; preset: SessionPreset }>(
    `/api/presets/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return result.preset;
}

export async function deletePreset(id: string): Promise<void> {
  await request(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getSkills(cwd: string): Promise<SkillsResponse> {
  const query = new URLSearchParams({ cwd });
  return request(`/api/skills?${query.toString()}`);
}

export async function setSkillDisabled(
  filePath: string,
  disableModelInvocation: boolean,
): Promise<void> {
  await request('/api/skills', {
    method: 'PATCH',
    body: JSON.stringify({ filePath, disableModelInvocation }),
  });
}

export function getPlan(sessionId: string): Promise<{ plan: PlanView }> {
  return request(`/api/agent/${encodeURIComponent(sessionId)}/plan`);
}

/**
 * 下发计划命令（M4 契约）。
 * 中文说明：响应体带上最新的 PlanView（服务端写入后立即返回），因此调用方可以马上
 * 反映状态而不必等 SSE——SSE 仍是权威通道（别的客户端/执行器也会改计划）。
 */
export async function sendPlanCommand(
  sessionId: string,
  action: 'start' | 'execute' | 'pause' | 'resume' | 'refine' | 'abandon',
  message?: string,
): Promise<{ plan: PlanView }> {
  const data = await sendAgentCommand(sessionId, {
    type: `plan_${action}`,
    ...(message ? { message } : {}),
  });
  return (data ?? {}) as { plan: PlanView };
}

export async function getMcpServers(cwd?: string): Promise<McpServersResponse> {
  // cwd 可选：缺省时后端只返回用户级配置（不连接、状态 idle），供预设编辑等
  // 没有工作区上下文的界面选择 MCP 白名单。
  const query = cwd ? new URLSearchParams({ cwd }) : '';
  return request(`/api/mcp/servers${query ? `?${query}` : ''}`);
}

export async function upsertMcpServer(input: McpServerInput): Promise<void> {
  await request('/api/mcp/servers', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateMcpServer(
  name: string,
  input: Omit<McpServerInput, 'name'>,
): Promise<void> {
  await request(`/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteMcpServer(name: string, cwd: string, scope: McpScope): Promise<void> {
  const query = new URLSearchParams({ cwd, scope });
  await request(`/api/mcp/servers/${encodeURIComponent(name)}?${query.toString()}`, {
    method: 'DELETE',
  });
}

export async function testMcpServer(
  name: string,
  cwd: string,
  scope: McpScope,
  server?: McpServerInput['server'],
): Promise<McpTestResult> {
  const body: Record<string, unknown> = { cwd, scope };
  if (server) body.server = server;
  return request(`/api/mcp/servers/${encodeURIComponent(name)}/test`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function fetchAgentEvents(
  sessionId: string,
  lastEventId: number,
  signal: AbortSignal,
): Promise<Response> {
  // 会话事件流：fetch + ReadableStream 手写解析 SSE 帧（不走 EventSource）。
  // 令牌放 Authorization 头（不进 URL，避免泄露到日志）；断线重连时带 Last-Event-ID
  // 请求头，让服务端从该序号之后补发缓存的未收事件。
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (lastEventId > 0) headers['Last-Event-ID'] = String(lastEventId);
  return fetch(`${BASE_URL}/api/agent/${encodeURIComponent(sessionId)}/events`, {
    headers,
    signal,
  });
}

export function listFiles(root: string, path = ''): Promise<FileListResponse> {
  return request(fileAccessUrl(root, path, 'list'));
}

export function readFile(root: string, path: string): Promise<FileReadResponse> {
  return request(fileAccessUrl(root, path, 'read'));
}

export function fileMediaUrl(root: string, path: string): string {
  // 图片/音频预览地址（直接作为 <img>/<audio> 的 src，需带绝对前缀；
  // <img> 无法带 Authorization 头，令牌走查询参数）
  return appendToken(BASE_URL + fileAccessUrl(root, path, 'media'));
}

function fileAccessUrl(root: string, path: string, type: 'list' | 'read' | 'media'): string {
  // 构造 /api/files 访问 URL：路径规范化并逐段编码，root 与 type 走查询参数
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  const encodedPath = normalized.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const query = new URLSearchParams({ root, type });
  return `/api/files/${encodedPath}?${query.toString()}`;
}

// ---- 可观测性（M1） ---------------------------------------------------------

/** 可观测性查询参数：时间窗（ISO 字符串）与工作区。 */
export interface ObservabilityQuery {
  from?: string;
  to?: string;
  cwd?: string;
}

function observabilityQuery(params: ObservabilityQuery = {}): string {
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.cwd) query.set('cwd', params.cwd);
  const text = query.toString();
  return text ? `?${text}` : '';
}

/** 汇总：成本、p95 延迟、工具成功率、审批命中率、每日用量。 */
export function getObservabilitySummary(
  params?: ObservabilityQuery,
): Promise<ObservabilitySummary> {
  return request(`/api/observability/summary${observabilityQuery(params)}`);
}

/** run 列表（按开始时间倒序，键集分页）。 */
export function listObservabilityRuns(
  params?: ObservabilityQuery & { sessionId?: string; limit?: number; cursor?: string },
): Promise<ObservabilityRunList> {
  const query = new URLSearchParams();
  if (params?.from) query.set('from', params.from);
  if (params?.to) query.set('to', params.to);
  if (params?.cwd) query.set('cwd', params.cwd);
  if (params?.sessionId) query.set('sessionId', params.sessionId);
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.cursor) query.set('cursor', params.cursor);
  const text = query.toString();
  return request(`/api/observability/runs${text ? `?${text}` : ''}`);
}

/** run 详情（含 steps 与子 run）。 */
export function getObservabilityRun(runId: string): Promise<ObservabilityRunDetail> {
  return request(`/api/observability/runs/${encodeURIComponent(runId)}`);
}

/** 清理 before 之前的明细（预聚合历史保留）。 */
export async function pruneObservabilityRuns(before: string): Promise<{ deletedRuns: number }> {
  return request(`/api/observability/runs?before=${encodeURIComponent(before)}`, {
    method: 'DELETE',
  });
}

// ---- 任务（M2） -------------------------------------------------------------

/** 任务列表（按 updatedAt 倒序）。 */
export async function listTasks(
  params: { status?: TaskStatus; sessionId?: string; cwd?: string; limit?: number } = {},
): Promise<TaskRecord[]> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.sessionId) query.set('sessionId', params.sessionId);
  if (params.cwd) query.set('cwd', params.cwd);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const text = query.toString();
  const result = await request<{ tasks: TaskRecord[] }>(`/api/tasks${text ? `?${text}` : ''}`);
  return result.tasks;
}

/** 任务详情。 */
export async function getTask(taskId: string): Promise<TaskRecord> {
  const result = await request<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(taskId)}`);
  return result.task;
}

export interface CreateTaskInput {
  title: string;
  goal: string;
  sessionId?: string;
  cwd?: string;
  steps?: Array<{
    title: string;
    details?: string;
    verification?: TaskVerification;
    position?: number;
  }>;
}

/** 新建任务。 */
export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const result = await request<{ task: TaskRecord }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return result.task;
}

/** 修改任务（必须带 ifRevision；版本不匹配后端返回 409 task_conflict）。 */
export async function updateTask(
  taskId: string,
  patch: {
    title?: string;
    goal?: string;
    status?: TaskStatus;
    blockedReason?: string;
    conclusion?: string;
    ifRevision: number;
  },
): Promise<TaskRecord> {
  const result = await request<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return result.task;
}

/** 取消任务（终态；不带 ifRevision 时是幂等 no-op）。 */
export async function cancelTask(
  taskId: string,
  input: { ifRevision?: number; reason?: string } = {},
): Promise<TaskRecord> {
  const result = await request<{ task: TaskRecord }>(
    `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.task;
}

/** 追加步骤。 */
export async function addTaskStep(
  taskId: string,
  input: { title: string; details?: string; verification?: TaskVerification; ifRevision: number },
): Promise<TaskRecord> {
  const result = await request<{ task: TaskRecord }>(
    `/api/tasks/${encodeURIComponent(taskId)}/steps`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.task;
}

/** 修改步骤（状态 / 文案 / 顺序 / 证据）。 */
export async function updateTaskStep(
  taskId: string,
  stepId: string,
  patch: {
    title?: string;
    details?: string;
    status?: TaskStepStatus;
    position?: number;
    evidence?: TaskEvidence;
    blockedReason?: string;
    ifRevision: number;
  },
): Promise<TaskRecord> {
  const result = await request<{ task: TaskRecord }>(
    `/api/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return result.task;
}

/** 删除步骤（已完成的需 force=true）。 */
export async function deleteTaskStep(
  taskId: string,
  stepId: string,
  input: { ifRevision: number; force?: boolean },
): Promise<TaskRecord> {
  const result = await request<{ task: TaskRecord }>(
    `/api/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}`,
    { method: 'DELETE', body: JSON.stringify(input) },
  );
  return result.task;
}

// ---- 任务断点续跑（M3） -----------------------------------------------------

/** 重启后待恢复的任务清单（只读，不会自动执行）。 */
export async function getTaskRecovery(): Promise<TaskRecoveryItem[]> {
  const result = await request<{ tasks: TaskRecoveryItem[] }>('/api/tasks/recovery');
  return result.tasks;
}

/**
 * 续跑/重试一个任务。
 * 中文说明：`confirmSideEffect` 只在用户明确知悉「上次可能已写入」时才传——
 * 服务端在没有它的情况下会返回 409 task_needs_confirmation，不会自行开跑。
 */
export async function resumeTask(
  taskId: string,
  input: { mode: 'continue' | 'retry_step' | 'replan'; confirmSideEffect?: boolean },
): Promise<TaskRecord> {
  const result = await request<{ task: TaskRecord }>(
    `/api/tasks/${encodeURIComponent(taskId)}/resume`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.task;
}

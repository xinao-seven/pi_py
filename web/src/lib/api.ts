// REST 客户端：封装全部后端 API，统一错误解析（ApiError）。
import { BASE_URL } from './config';
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
  SessionDetail,
  SessionInfo,
  SkillsResponse,
  PlanSnapshot,
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
  // 通用请求：自动加 JSON Content-Type，非 2xx 时解析后端错误信封并抛 ApiError
  const response = await fetch(BASE_URL + path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as T | ErrorEnvelope | null;
  if (!response.ok) {
    const error = (body as ErrorEnvelope | null)?.error;
    throw new ApiError(
      error?.message ?? `请求失败（${response.status}）`,
      response.status,
      error?.code,
      error?.details,
    );
  }
  return body as T;
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
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
  images?: Array<{ type: 'image'; data: string; mimeType: string }>;
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

export function getPlan(sessionId: string): Promise<{ plan: PlanSnapshot }> {
  return request(`/api/agent/${encodeURIComponent(sessionId)}/plan`);
}

export async function sendPlanCommand(
  sessionId: string,
  action: 'enable' | 'disable' | 'execute' | 'refine',
  message?: string,
): Promise<void> {
  await sendAgentCommand(sessionId, { type: `plan_${action}`, ...(message ? { message } : {}) });
}

export async function getMcpServers(cwd: string): Promise<McpServersResponse> {
  const query = new URLSearchParams({ cwd });
  return request(`/api/mcp/servers?${query.toString()}`);
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

export function agentEventsUrl(sessionId: string): string {
  // SSE 事件流地址
  return `${BASE_URL}/api/agent/${encodeURIComponent(sessionId)}/events`;
}

export function listFiles(root: string, path = ''): Promise<FileListResponse> {
  return request(fileAccessUrl(root, path, 'list'));
}

export function readFile(root: string, path: string): Promise<FileReadResponse> {
  return request(fileAccessUrl(root, path, 'read'));
}

export function fileMediaUrl(root: string, path: string): string {
  // 图片/音频预览地址（直接作为 <img>/<audio> 的 src，需带绝对前缀）
  return BASE_URL + fileAccessUrl(root, path, 'media');
}

function fileAccessUrl(root: string, path: string, type: 'list' | 'read' | 'media'): string {
  // 构造 /api/files 访问 URL：路径规范化并逐段编码，root 与 type 走查询参数
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  const encodedPath = normalized.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const query = new URLSearchParams({ root, type });
  return `/api/files/${encodedPath}?${query.toString()}`;
}

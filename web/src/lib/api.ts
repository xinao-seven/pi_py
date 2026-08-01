import type {
  AgentStateResponse,
  FileListResponse,
  FileReadResponse,
  ForkSessionResponse,
  MergeSessionResponse,
  ModelCatalog,
  ModelsConfigValue,
  SessionDetail,
  SessionInfo,
  SkillsResponse,
} from "@/types";

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "request_failed",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
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
  const result = await request<{ sessions: SessionInfo[] }>("/api/sessions");
  return result.sessions;
}

export function getSession(sessionId: string): Promise<SessionDetail> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function forkSession(sessionId: string, leafId: string): Promise<ForkSessionResponse> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: "POST",
    body: JSON.stringify({ leafId }),
  });
}

export function mergeSession(
  targetSessionId: string,
  sourceSessionId: string,
): Promise<MergeSessionResponse> {
  return request(`/api/sessions/${encodeURIComponent(targetSessionId)}/merge`, {
    method: "POST",
    body: JSON.stringify({ sourceSessionId }),
  });
}

export function getAgentState(sessionId: string): Promise<AgentStateResponse> {
  return request(`/api/agent/${encodeURIComponent(sessionId)}`);
}

export async function createDefaultWorkspace(): Promise<string> {
  const result = await request<{ cwd: string }>("/api/default-cwd", { method: "POST" });
  return result.cwd;
}

export async function getWorkspaceHome(): Promise<string> {
  const result = await request<{ home: string }>("/api/home");
  return result.home;
}

export async function listWorkspaces(): Promise<string[]> {
  const result = await request<{ workspaces: string[] }>("/api/workspaces");
  return result.workspaces;
}

export async function selectWorkspace(cwd: string): Promise<string> {
  const result = await request<{ cwd: string }>("/api/workspaces/select", {
    method: "POST",
    body: JSON.stringify({ cwd }),
  });
  return result.cwd;
}

export async function createAgent(input: {
  cwd: string;
  message: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}): Promise<string> {
  const result = await request<{ success: true; sessionId: string }>("/api/agent/new", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.sessionId;
}

export async function sendAgentCommand(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await request<{ success: true; data: Record<string, unknown> }>(
    `/api/agent/${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      body: JSON.stringify(command),
    },
  );
  return result.data;
}

export function getModels(): Promise<ModelCatalog> {
  return request("/api/models");
}

export function getModelsConfig(): Promise<ModelsConfigValue> {
  return request("/api/models-config");
}

export async function saveModelsConfig(value: ModelsConfigValue): Promise<void> {
  await request("/api/models-config", {
    method: "PUT",
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
  await request("/api/skills", {
    method: "PATCH",
    body: JSON.stringify({ filePath, disableModelInvocation }),
  });
}

export function agentEventsUrl(sessionId: string): string {
  return `/api/agent/${encodeURIComponent(sessionId)}/events`;
}

export function listFiles(root: string, path = ""): Promise<FileListResponse> {
  return request(fileAccessUrl(root, path, "list"));
}

export function readFile(root: string, path: string): Promise<FileReadResponse> {
  return request(fileAccessUrl(root, path, "read"));
}

export function fileMediaUrl(root: string, path: string): string {
  return fileAccessUrl(root, path, "media");
}

function fileAccessUrl(
  root: string,
  path: string,
  type: "list" | "read" | "media",
): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const encodedPath = normalized.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const query = new URLSearchParams({ root, type });
  return `/api/files/${encodedPath}?${query.toString()}`;
}

/**
 * MCP server 配置的读写、合并与校验（纯逻辑，不依赖 Fastify / MCP SDK）。
 *
 * 中文说明：MCP server 清单按"用户级 + 工作区级"两层存储，对齐 SDK 已有的
 * `~/.pi/agent/extensions/` 与 `{cwd}/.pi/extensions/` 发现约定：
 * - 用户级：`{agentDir}/mcp.json`（全局默认，通常为 ~/.pi/agent/mcp.json）；
 * - 工作区级：`{cwd}/.pi/mcp.json`（按 server name 覆盖用户级）。
 *
 * `effective(cwd)` 返回合并后的列表，每个条目携带来源 scope，供 REST 层决定
 * 更新/删除时写回哪个文件。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ApiError } from "../../errors.js";

/** MCP 传输类型：stdio（本地子进程）或 streamable-http（远程）。 */
export type McpTransport = "stdio" | "streamable-http";
/** 配置作用域：用户级还是工作区级。 */
export type McpScope = "user" | "workspace";

/** 单个 MCP server 的配置（对应配置文件里的一个条目）。 */
export interface McpServerConfig {
  transport: McpTransport;
  /** stdio 专用：可执行命令。 */
  command?: string;
  /** stdio 专用：命令行参数。 */
  args?: string[];
  /** stdio 专用：附加环境变量（值支持 $ENV 插值，见 mcp-tools.ts）。 */
  env?: Record<string, string>;
  /** stdio 专用：子进程工作目录。 */
  cwd?: string;
  /** streamable-http 专用：MCP endpoint 地址。 */
  url?: string;
  /** streamable-http 专用：附加请求头（值支持 $ENV 插值）。 */
  headers?: Record<string, string>;
  /** 是否启用；缺省视为启用。 */
  enabled?: boolean;
  /** 可选：该 server 的所有工具调用都需人工审批。 */
  approval?: "required";
}

/** 合并后带作用域信息的 server 条目（REST 层用）。 */
export interface ResolvedServer extends McpServerConfig {
  name: string;
  scope: McpScope;
}

const FILE_NAME = "mcp.json";

/**
 * 配置存取。每次读取都直接从磁盘加载（配置量小，避免引入缓存一致性复杂度），
 * 写入采用读-改-写，保证不丢失同文件里其他 server 的配置。
 */
export class McpConfig {
  constructor(private readonly agentDir: string) {}

  userPath(): string {
    return join(this.agentDir, FILE_NAME);
  }

  workspacePath(cwd: string): string {
    return join(cwd, ".pi", FILE_NAME);
  }

  /** 读取单个配置文件；文件缺失或 JSON 损坏时返回空表（不抛错，防御性）。 */
  read(path: string): Record<string, McpServerConfig> {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { servers?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.servers === "object" && parsed.servers !== null) {
        return parsed.servers as Record<string, McpServerConfig>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** 合并用户级与工作区级配置：工作区按 name 覆盖用户级；返回带 scope 的列表。 */
  effective(cwd: string): ResolvedServer[] {
    const user = this.read(this.userPath());
    const workspace = this.read(this.workspacePath(cwd));
    const byName = new Map<string, ResolvedServer>();
    // 配置文件可能被手工编辑，防御性跳过非对象条目，避免下游崩溃。
    for (const [name, config] of Object.entries(user)) {
      if (isServerConfig(config)) byName.set(name, { ...config, name, scope: "user" });
    }
    for (const [name, config] of Object.entries(workspace)) {
      if (isServerConfig(config)) byName.set(name, { ...config, name, scope: "workspace" });
    }
    return [...byName.values()];
  }

  /** 写入/更新一个 server 到指定作用域的文件（读-改-写）。 */
  upsert(cwd: string, scope: McpScope, name: string, server: McpServerConfig): void {
    const path = scope === "workspace" ? this.workspacePath(cwd) : this.userPath();
    const servers = this.read(path);
    servers[name] = server;
    this.write(path, servers);
  }

  /** 从指定作用域的文件删除一个 server。 */
  remove(cwd: string, scope: McpScope, name: string): void {
    const path = scope === "workspace" ? this.workspacePath(cwd) : this.userPath();
    const servers = this.read(path);
    if (name in servers) {
      delete servers[name];
      this.write(path, servers);
    }
  }

  private write(path: string, servers: Record<string, McpServerConfig>): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ servers }, null, 2) + "\n", "utf8");
  }
}

/**
 * 校验并归一化来自 HTTP body 的 server 配置。
 * 中文说明：宽松校验 —— 传输类型必填，stdio 需要 command，streamable-http 需要合法 url；
 * 其余字段按类型检查，非法即 422。
 */
export function parseServerConfig(input: unknown): McpServerConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(422, "validation_error", "MCP server config must be an object");
  }
  const raw = input as Record<string, unknown>;
  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw new ApiError(422, "validation_error", "transport must be \"stdio\" or \"streamable-http\"");
  }
  const config: McpServerConfig = { transport };

  if (transport === "stdio") {
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      throw new ApiError(422, "validation_error", "stdio transport requires a non-empty command");
    }
    config.command = raw.command.trim();
    config.args = optionalStringArray(raw.args, "args");
    config.env = optionalStringMap(raw.env, "env");
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== "string") throw new ApiError(422, "validation_error", "cwd must be a string");
      config.cwd = raw.cwd;
    }
  } else {
    if (typeof raw.url !== "string" || !raw.url.trim()) {
      throw new ApiError(422, "validation_error", "streamable-http transport requires a url");
    }
    try {
      config.url = new URL(raw.url.trim()).toString();
    } catch {
      throw new ApiError(422, "validation_error", "url must be a valid URL");
    }
    config.headers = optionalStringMap(raw.headers, "headers");
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new ApiError(422, "validation_error", "enabled must be a boolean");
    config.enabled = raw.enabled;
  }
  if (raw.approval !== undefined) {
    if (raw.approval !== "required") throw new ApiError(422, "validation_error", "approval must be \"required\"");
    config.approval = raw.approval;
  }
  return config;
}

function isServerConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const transport = (value as { transport?: unknown }).transport;
  return transport === "stdio" || transport === "streamable-http";
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ApiError(422, "validation_error", `${field} must be an array of strings`);
  }
  return value;
}

function optionalStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", `${field} must be an object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new ApiError(422, "validation_error", `${field}.${key} must be a string`);
    out[key] = item;
  }
  return out;
}

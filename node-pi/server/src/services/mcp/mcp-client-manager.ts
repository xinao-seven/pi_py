/**
 * MCP 客户端连接池。
 *
 * 中文说明：进程级单例持有所有 MCP 连接（键为 `{cwd}:{serverName}`），同一工作区的
 * 多个会话共享同一连接，避免重复 spawn stdio 子进程。职责：
 * - sync()：把某个 cwd 的连接状态对账到"期望配置"（连接缺失/配置变化的、断开已删除/禁用的）；
 * - callTool()：按 server + tool 名调用 MCP 工具；
 * - status()：连接状态快照（前端展示用）；
 * - dispose()：服务关闭时关闭全部连接。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { ApiError } from '../../errors.js';
import type { ServiceLogger } from '../service-logger.js';
import type { McpServerConfig } from './mcp-config.js';
import { fingerprintOf, interpolateEnvMap } from './mcp-tools.js';

/** 连接状态（前端徽标用）。 */
export type ServerStatus = 'connected' | 'connecting' | 'error' | 'disabled';

/** 连接池中的一个受管 server。 */
export interface ManagedServer {
  key: string;
  name: string;
  cwd: string;
  config: McpServerConfig;
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport;
  status: ServerStatus;
  error?: string;
  tools: Tool[];
  fingerprint: string;
}

/** 试连结果（probe 用，不进入连接池）。 */
export interface McpProbeResult {
  ok: boolean;
  error?: string;
  tools: Array<{ name: string; description?: string }>;
}

/** stdio 子进程启动 + 握手默认超时。 */
const CONNECT_TIMEOUT_MS = 15_000;

export class McpClientManager {
  private readonly servers = new Map<string, ManagedServer>();

  constructor(
    private readonly logger?: ServiceLogger,
    private readonly connectTimeoutMs = CONNECT_TIMEOUT_MS,
  ) {}

  /**
   * 把某 cwd 的连接对账到期望配置。
   * - 配置被删除 / 禁用 / 指纹变化 → 断开；
   * - 尚未连接且启用 → 连接并发现工具。
   */
  async sync(
    cwd: string,
    desired: Array<{ name: string; config: McpServerConfig }>,
  ): Promise<void> {
    const desiredByName = new Map(desired.map((entry) => [entry.name, entry]));
    for (const [key, server] of [...this.servers]) {
      if (server.cwd !== cwd) continue;
      const next = desiredByName.get(server.name);
      const enabled = next !== undefined && next.config.enabled !== false;
      const unchanged = next !== undefined && fingerprintOf(next.config) === server.fingerprint;
      if (!next || !enabled || !unchanged) {
        await this.disconnect(key);
        this.servers.delete(key);
      }
    }
    for (const { name, config } of desired) {
      if (config.enabled === false) continue;
      const key = `${cwd}:${name}`;
      if (this.servers.has(key)) continue;
      await this.connect(key, cwd, name, config);
    }
  }

  /** 调用某个已连接 server 的 MCP 工具；未连接抛 503。 */
  async callTool(
    cwd: string,
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const server = this.servers.get(`${cwd}:${name}`);
    if (!server?.client) {
      throw new ApiError(503, 'mcp_not_connected', `MCP server "${name}" is not connected`);
    }
    const startedAt = Date.now();
    try {
      // callTool 的返回类型是内联联合（含 toolResult 变体），我们只需要 CallToolResult 形状。
      const result = (await server.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        signal ? { signal } : undefined,
      )) as CallToolResult;
      this.logger?.info(
        {
          server: name,
          tool: toolName,
          durationMs: Date.now() - startedAt,
          isError: Boolean(result.isError),
        },
        'mcp tool call finished',
      );
      return result;
    } catch (error) {
      this.logger?.error(
        { server: name, tool: toolName, durationMs: Date.now() - startedAt, err: error },
        'mcp tool call failed',
      );
      throw error;
    }
  }

  /** 某 server 是否配置了审批要求。 */
  approvalRequired(cwd: string, name: string): boolean {
    const server = this.servers.get(`${cwd}:${name}`);
    return server?.config.approval === 'required';
  }

  /** 某 cwd 下全部 server 的状态快照（含工具清单，供 REST 层与工具注册用）。 */
  status(cwd: string): ManagedServer[] {
    return [...this.servers.values()].filter((server) => server.cwd === cwd);
  }

  /** 试连单个 server：连接 → 列工具 → 关闭，不进入连接池。 */
  async probe(config: McpServerConfig): Promise<McpProbeResult> {
    try {
      const { client, transport, tools } = await this.openAndList(config);
      try {
        await client.close();
      } catch {
        /* 忽略 */
      }
      try {
        await transport.close();
      } catch {
        /* 忽略 */
      }
      return {
        ok: true,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
      };
    } catch (error) {
      this.logger?.warn(
        {
          transport: config.transport,
          command: config.command,
          url: config.url,
          err: error instanceof Error ? error.message : String(error),
        },
        'mcp probe failed',
      );
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        tools: [],
      };
    }
  }

  /** 服务关闭 / 热重启时关闭全部连接。 */
  async dispose(): Promise<void> {
    for (const key of [...this.servers.keys()]) {
      await this.disconnect(key);
      this.servers.delete(key);
    }
  }

  private async connect(
    key: string,
    cwd: string,
    name: string,
    config: McpServerConfig,
  ): Promise<void> {
    const managed: ManagedServer = {
      key,
      name,
      cwd,
      config,
      status: 'connecting',
      tools: [],
      fingerprint: fingerprintOf(config),
    };
    this.servers.set(key, managed);
    try {
      const { client, transport, tools } = await this.openAndList(config, cwd);
      managed.client = client;
      managed.transport = transport;
      managed.tools = tools;
      managed.status = 'connected';
      this.logger?.info(
        { server: name, cwd, transport: config.transport, toolCount: tools.length },
        'mcp server connected',
      );
    } catch (error) {
      managed.status = 'error';
      managed.error = error instanceof Error ? error.message : String(error);
      managed.transport = undefined;
      this.logger?.warn(
        { server: name, cwd, transport: config.transport, err: managed.error },
        'mcp server connect failed',
      );
    }
  }

  private async disconnect(key: string): Promise<void> {
    const server = this.servers.get(key);
    if (!server) return;
    this.logger?.info({ server: server.name, cwd: server.cwd }, 'mcp server disconnected');
    try {
      await server.client?.close();
    } catch {
      /* 已断开可忽略 */
    }
    try {
      await server.transport?.close();
    } catch {
      /* 已断开可忽略 */
    }
    server.client = undefined;
    server.transport = undefined;
    server.tools = [];
  }

  /** 连接一个 server 并列出工具；失败时关闭 transport 并抛错。 */
  private async openAndList(
    config: McpServerConfig,
    defaultCwd?: string,
  ): Promise<{
    client: Client;
    transport: StdioClientTransport | StreamableHTTPClientTransport;
    tools: Tool[];
  }> {
    const transport = this.buildTransport(config, defaultCwd);
    try {
      const client = new Client({ name: 'pi-web-mcp', version: '1.0.0' }, { capabilities: {} });
      await withTimeout(client.connect(transport), this.connectTimeoutMs);
      const result = await client.listTools();
      return { client, transport, tools: result.tools };
    } catch (error) {
      try {
        await transport.close();
      } catch {
        /* 忽略 */
      }
      throw error;
    }
  }

  private buildTransport(
    config: McpServerConfig,
    defaultCwd?: string,
  ): StdioClientTransport | StreamableHTTPClientTransport {
    if (config.transport === 'stdio') {
      return new StdioClientTransport({
        command: config.command ?? '',
        args: config.args ?? [],
        // 合并 process.env，保证 npx 等依赖 PATH 的命令可用；用户 env 覆盖同名项。
        env: {
          ...(process.env as Record<string, string>),
          ...(interpolateEnvMap(config.env) ?? {}),
        },
        // stdio 子进程工作目录：未配置时默认落在会话工作区。
        cwd: config.cwd ?? defaultCwd ?? process.cwd(),
      });
    }
    return new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
      requestInit: config.headers ? { headers: interpolateEnvMap(config.headers) } : undefined,
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP connection timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

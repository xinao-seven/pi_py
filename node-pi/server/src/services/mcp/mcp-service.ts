/**
 * MCP 门面服务：组合配置存取与连接池，对 REST 层和 MCP 内联扩展提供统一入口。
 *
 * 中文说明：本类是 MCP 功能的"唯一真相源"：
 * - 配置变更（REST）→ 持久化 + 连接对账（ensure）；
 * - 扩展工厂通过 ensure() 连接、toolsFor() 拿到 ToolDefinition 列表注册进会话；
 * - 工具调用按 Pi 工具名（mcp__<server>__<tool>）经 toolIndex 解析回 server/tool，
 *   再委托给连接池执行；toolIndex 在每次 toolsFor() 时重建（处理命名冲突后的权威映射）。
 */

import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { ApiError } from '../../errors.js';
import type { ServiceLogger } from '../service-logger.js';
import { McpClientManager, type McpProbeResult, type ServerStatus } from './mcp-client-manager.js';
import {
  McpConfig,
  type McpScope,
  type McpServerConfig,
  type ResolvedServer,
} from './mcp-config.js';
import {
  buildMcpToolDefinition,
  mcpResultToPi,
  parseMcpToolName,
  serializeMcpToolName,
} from './mcp-tools.js';

/** REST 层返回的 server 视图：配置 + 实时连接状态 + 工具清单。 */
export interface McpServerView {
  name: string;
  scope: McpScope;
  enabled: boolean;
  status: ServerStatus;
  error?: string;
  toolCount: number;
  tools: Array<{ name: string; description?: string }>;
  transport: McpServerConfig['transport'];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  approval?: 'required';
}

/** 工具名 → 真实 server/tool 的权威映射（每次 toolsFor 重建）。 */
type ToolIndex = Map<string, { server: string; tool: string }>;

export class McpService {
  private readonly manager: McpClientManager;
  private readonly toolIndex = new Map<string, ToolIndex>();

  constructor(
    private readonly config: McpConfig,
    manager?: McpClientManager,
    logger?: ServiceLogger,
  ) {
    this.manager = manager ?? new McpClientManager(logger);
  }

  /** 使某 cwd 的连接对账到当前配置（扩展工厂 / 配置变更后调用，幂等）。 */
  async ensure(cwd: string): Promise<void> {
    const desired = this.config.effective(cwd).map(({ name, ...config }) => ({ name, config }));
    await this.manager.sync(cwd, desired);
  }

  /**
   * 构建当前 cwd 下所有已连接 server 的工具定义（供扩展注册进会话）。
   * allowedServers 为 MCP 服务名白名单（null = 全部，[] = 禁用）。
   * 中文说明：工具名的分配与 toolIndex 始终基于"全部已连接 server"计算，
   * 白名单只决定哪些定义返回 —— 不同预设的会话共享同一 toolIndex，互不污染；
   * 否则按各自白名单重建 index 会互相覆盖，导致其他会话工具解析失败。
   */
  toolsFor(cwd: string, allowedServers?: ReadonlySet<string> | null): ToolDefinition[] {
    const used = new Set<string>();
    const index: ToolIndex = new Map();
    const definitions: Array<ToolDefinition | undefined> = [];
    for (const server of this.manager.status(cwd)) {
      if (server.status !== 'connected') continue;
      const included = !allowedServers || allowedServers.has(server.name);
      for (const tool of server.tools) {
        const base = serializeMcpToolName(server.name, tool.name);
        let fullName = base;
        for (let suffix = 2; used.has(fullName); suffix++) fullName = `${base}_${suffix}`;
        used.add(fullName);
        index.set(fullName, { server: server.name, tool: tool.name });
        definitions.push(
          included
            ? buildMcpToolDefinition({
                name: fullName,
                serverName: server.name,
                toolName: tool.name,
                tool,
                callTool: (args, signal) => this.callTool(cwd, fullName, args, signal),
              })
            : undefined,
        );
      }
    }
    this.toolIndex.set(cwd, index);
    return definitions.filter((definition) => definition !== undefined);
  }

  /** 解析 Pi 工具名 → server/tool：优先 toolIndex，回退命名解析。 */
  resolveTool(cwd: string, fullName: string): { server: string; tool: string } | undefined {
    return this.toolIndex.get(cwd)?.get(fullName) ?? parseMcpToolName(fullName);
  }

  /** 调用 MCP 工具（按 Pi 工具名）；结果已转为 Pi AgentToolResult。 */
  async callTool(
    cwd: string,
    fullName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> {
    const resolved = this.resolveTool(cwd, fullName);
    if (!resolved) throw new ApiError(404, 'mcp_tool_not_found', `Unknown MCP tool: ${fullName}`);
    const result = await this.manager.callTool(cwd, resolved.server, resolved.tool, args, signal);
    return mcpResultToPi(result);
  }

  /** 某 MCP 工具是否需要人工审批（approval: "required"）。 */
  approvalRequired(cwd: string, fullName: string): boolean {
    const resolved = this.resolveTool(cwd, fullName);
    return resolved ? this.manager.approvalRequired(cwd, resolved.server) : false;
  }

  /** REST：列出某 cwd 的有效 server 配置 + 连接状态。 */
  async listServers(cwd: string): Promise<McpServerView[]> {
    await this.ensure(cwd);
    const managed = this.manager.status(cwd);
    return this.config.effective(cwd).map((server) => {
      const entry = managed.find((item) => item.name === server.name);
      return this.viewOf(server, entry?.status ?? 'connecting', entry);
    });
  }

  /**
   * REST：仅列出用户级 server 配置（无 cwd 上下文时用，如预设编辑界面）。
   * 中文说明：不建立连接——连接池按 cwd 分键，没有工作区就没有连接语义；
   * status 固定 idle，真实连接状态需带 cwd 调 listServers()。
   */
  listUserServers(): McpServerView[] {
    return this.config.userServers().map((server) => this.viewOf(server, 'idle'));
  }

  /** 组装 REST 视图：配置 + 状态 + 工具清单（禁用的 server 一律标 disabled）。 */
  private viewOf(
    server: ResolvedServer,
    status: ServerStatus,
    entry?: { error?: string; tools: Array<{ name: string; description?: string }> },
  ): McpServerView {
    return {
      name: server.name,
      scope: server.scope,
      enabled: server.enabled !== false,
      status: server.enabled === false ? 'disabled' : status,
      error: entry?.error,
      toolCount: entry?.tools.length ?? 0,
      tools: (entry?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      headers: server.headers,
      approval: server.approval,
    };
  }

  /** REST：新增/更新 server 并同步连接。 */
  async upsertServer(
    cwd: string,
    scope: McpScope,
    name: string,
    server: McpServerConfig,
  ): Promise<void> {
    this.config.upsert(cwd, scope, name, server);
    await this.ensure(cwd);
  }

  /** REST：删除 server 并断开连接。 */
  async deleteServer(cwd: string, scope: McpScope, name: string): Promise<void> {
    this.config.remove(cwd, scope, name);
    await this.ensure(cwd);
  }

  /** REST：试连一个 server（可传入未保存的配置）。 */
  async testServer(
    cwd: string,
    scope: McpScope,
    name: string,
    config?: McpServerConfig,
  ): Promise<McpProbeResult> {
    const toProbe = config ?? this.config.effective(cwd).find((server) => server.name === name);
    if (!toProbe)
      throw new ApiError(404, 'mcp_server_not_found', `MCP server "${name}" was not found`);
    return this.manager.probe(toProbe);
  }

  /** REST：强制重连某 cwd 下所有 server。 */
  async refresh(cwd: string): Promise<void> {
    await this.manager.sync(cwd, []);
    await this.ensure(cwd);
  }

  /** 服务关闭：释放全部连接。 */
  async dispose(): Promise<void> {
    await this.manager.dispose();
    this.toolIndex.clear();
  }
}

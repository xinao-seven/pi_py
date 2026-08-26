/**
 * MCP server 配置的 REST 路由。
 *
 * 中文说明：为前端提供 MCP server 的增删改查、试连与强制重连。
 * 任何配置变更后都会触发 registry.reloadResources()，让所有活跃会话的 MCP 内联扩展
 * 重新注册工具集（新增/删除立即生效）——与 skills 路由的开关模式一致。
 */

import type { FastifyPluginAsync } from 'fastify';
import { stat } from 'node:fs/promises';

import { ApiError } from '../errors.js';
import { AgentRegistry } from '../services/agent-registry.js';
import { McpService } from '../services/mcp/mcp-service.js';
import { parseServerConfig, type McpScope } from '../services/mcp/mcp-config.js';

/** 注册 mcpRoutes 插件时所需的选项（由 app.ts 传入）。 */
export interface McpRouteOptions {
  service: McpService;
  registry: AgentRegistry;
}

/** 请求体里的可选字段（宽松类型，逐项校验）。server 为嵌套的 MCP server 配置。 */
interface McpBody extends Record<string, unknown> {
  name?: unknown;
  cwd?: unknown;
  scope?: unknown;
  server?: unknown;
}

export const mcpRoutes: FastifyPluginAsync<McpRouteOptions> = async (app, options) => {
  // GET /api/mcp/servers?cwd=<工作区> —— 合并配置 + 实时连接状态 + 工具清单。
  app.get<{ Querystring: { cwd?: string } }>('/servers', async (request) => {
    return { servers: await options.service.listServers(await requiredCwd(request.query.cwd)) };
  });

  // POST /api/mcp/servers —— 新增/更新一个 server。
  // body 形状：{ name, cwd(工作区), scope?, server: { transport, ... } }。
  // server 嵌套在 `server` 键下，避免工作区 cwd 与 stdio 子进程 cwd 字段重名。
  app.post('/servers', async (request) => {
    const body = (request.body ?? {}) as McpBody;
    const name = requiredName(body.name);
    const cwd = await requiredCwd(body.cwd);
    const scope = scopeOf(body.scope);
    await options.service.upsertServer(cwd, scope, name, parseServerConfig(body.server));
    await options.registry.reloadResources();
    return { success: true };
  });

  // PATCH /api/mcp/servers/:name —— 用完整配置覆盖更新指定 server。
  app.patch<{ Params: { name: string } }>('/servers/:name', async (request) => {
    const body = (request.body ?? {}) as McpBody;
    const cwd = await requiredCwd(body.cwd);
    const scope = scopeOf(body.scope);
    await options.service.upsertServer(
      cwd,
      scope,
      request.params.name,
      parseServerConfig(body.server),
    );
    await options.registry.reloadResources();
    return { success: true };
  });

  // DELETE /api/mcp/servers/:name?cwd=&scope= —— 删除 server。
  app.delete<{ Params: { name: string }; Querystring: { cwd?: string; scope?: string } }>(
    '/servers/:name',
    async (request) => {
      const cwd = await requiredCwd(request.query.cwd);
      await options.service.deleteServer(cwd, scopeOf(request.query.scope), request.params.name);
      await options.registry.reloadResources();
      return { success: true };
    },
  );

  // POST /api/mcp/servers/:name/test —— 试连：连接 → 列工具 → 断开。
  // body 带 server 配置时视为待测配置（未保存的表单），否则测已保存的配置。
  app.post<{ Params: { name: string } }>('/servers/:name/test', async (request) => {
    const body = (request.body ?? {}) as McpBody;
    const cwd = await requiredCwd(body.cwd);
    const scope = scopeOf(body.scope);
    const config = body.server !== undefined ? parseServerConfig(body.server) : undefined;
    const result = await options.service.testServer(cwd, scope, request.params.name, config);
    return {
      success: result.ok,
      error: result.error,
      toolCount: result.tools.length,
      tools: result.tools,
    };
  });

  // POST /api/mcp/refresh —— 强制断开并重连某 cwd 下所有 server。
  app.post('/refresh', async (request) => {
    const body = (request.body ?? {}) as McpBody;
    await options.service.refresh(await requiredCwd(body.cwd));
    await options.registry.reloadResources();
    return { success: true };
  });
};

async function requiredCwd(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(422, 'validation_error', 'cwd is required');
  }
  const cwd = value.trim();
  try {
    if (!(await stat(cwd)).isDirectory())
      throw new ApiError(400, 'invalid_workspace', `Workspace does not exist: ${cwd}`);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_workspace', `Workspace does not exist: ${cwd}`);
  }
  return cwd;
}

function requiredName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(422, 'validation_error', 'server name is required');
  }
  return value.trim();
}

function scopeOf(value: unknown): McpScope {
  if (value === undefined) return 'user';
  if (value !== 'user' && value !== 'workspace') {
    throw new ApiError(422, 'validation_error', 'scope must be "user" or "workspace"');
  }
  return value;
}

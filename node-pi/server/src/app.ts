/**
 * Fastify 应用工厂。
 *
 * 中文说明：集中装配跨域插件、各业务路由插件、全局错误处理与生命周期钩子。
 * 把 Pi Session 相关的复杂逻辑隔离在 services/ 里，通过插件选项（options）
 * 注入给路由，HTTP 层不直接依赖 Pi SDK 细节，便于单元测试与替换实现。
 *
 * Fastify 概念速览（本文件全部用到）：
 * - FastifyInstance：应用实例，既是 HTTP 服务器，也是"插件封装"的容器；
 * - app.register(plugin, options)：注册插件。Fastify 插件就是一个 async 函数
 *   (app, options) => {...}，可以在自己的封装作用域里注册路由、钩子、装饰器；
 * - prefix：注册插件时传入的路径前缀，给插件内所有路由统一加前缀；
 * - app.setErrorHandler()：全局错误处理器，路由里 throw 的错误都会汇聚到这里；
 * - app.addHook("onReady" / "onClose")：生命周期钩子，分别在"开始监听前"和
 *   "应用关闭时"执行，适合做资源初始化和清理。
 */

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ApiError, errorPayload } from './errors.js';
import type { TraceConfig } from './config.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agent.js';
import { fileRoutes } from './routes/files.js';
import { modelRoutes } from './routes/models.js';
import { presetRoutes } from './routes/presets.js';
import { sessionRoutes } from './routes/sessions.js';
import { skillRoutes } from './routes/skills.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { AgentRegistry, OriginalPiSessionFactory } from './services/agent-registry.js';
import { FileService } from './services/file-service.js';
import { ModelCatalogService } from './services/model-catalog.js';
import { ModelConfigService } from './services/model-config-service.js';
import { PresetService } from './services/preset-service.js';
import { SkillService } from './services/skill-service.js';
import { ToolApprovalBroker } from './services/tool-approval.js';
import { PlanModeService } from './services/plan-mode-service.js';
import { WorkspaceService } from './services/workspace-service.js';
import { McpService } from './services/mcp/mcp-service.js';
import { McpConfig } from './services/mcp/mcp-config.js';
import { SessionService } from './services/session-service.js';
import { openNullStore, openPlatformStore, type PlatformStore } from './services/platform/store.js';
import { SessionLedger } from './services/observability/session-ledger.js';
import { mcpRoutes } from './routes/mcp.js';
import { observabilityRoutes } from './routes/observability.js';

/**
 * createApp 的可选依赖注入参数。
 * 中文说明：测试时可以传入 mock 的 registry / service，避免真实读取
 * Pi 配置文件或真实操作文件系统；不传则使用生产默认实现。
 */
export interface AppOptions {
  agentDir?: string; // Pi agent 数据目录（auth.json / models.json / sessions/）
  registry?: AgentRegistry; // 会话注册表（活跃 Pi 会话 + SSE 事件缓存）
  workspaceParent?: string; // 默认工作区父目录
  workspaceService?: WorkspaceService; // 工作区登记与持久化
  modelCatalogService?: ModelCatalogService; // 模型目录（从 Pi SDK 读取）
  modelConfigService?: ModelConfigService; // models.json 读写
  presetService?: PresetService; // 会话预设读写
  planService?: PlanModeService;
  mcpService?: McpService; // MCP server 配置与连接池（测试可注入 mock）
  logger?: FastifyServerOptions['logger']; // Fastify 内置 Pino 日志器；默认 false（测试静默）
  webDistDir?: string; // 前端构建产物目录；提供且存在时托管静态页面（SPA 回退），否则仅 API
  accessPassword?: string; // 访问密码；非空时启用密码锁，/api 需登录令牌
  /** 平台存储（测试注入内存实现；显式提供即启用可观测性，忽略 trace.enabled）。 */
  store?: PlatformStore;
  /** trace 配置（生产由 server.ts 从 PI_NODE_TRACE_* 传入）。 */
  trace?: TraceConfig;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  // Fastify 内置 Pino 日志器：生产入口（server.ts）传入 logger 配置启用请求/错误日志；
  // 默认 false 保持测试（app.inject()）静默。app 同时也是一个"根插件封装"，
  // 后面所有 register 都挂在它下面，形成一个封装树（Fastify 的 Encapsulation 机制）。
  const app = Fastify({ logger: options.logger ?? false });

  // 注册 @fastify/cors 插件：origin: true 表示"反射请求来源"（即允许任意来源）。
  // 原因：uTools 插件以 file:// 或 utools:// 协议发起请求，没有标准 Origin 头；
  // 反射模式能放行这类客户端，并自动处理 JSON POST 的 CORS 预检（OPTIONS 请求）。
  app.register(cors, { origin: true });

  // 访问密码锁：/api/auth/status 始终存在（未启用时返回 enabled:false），
  // login/logout 仅启用时注册。配置了 PI_NODE_ACCESS_PASSWORD 后，/api 除公开
  // 端点外都需携带登录令牌（Authorization: Bearer 或 ?access_token=）。
  // 用 onRequest 而非 preHandler：未匹配的路由（404）与 SSE hijack 也会被拦，
  // 避免泄露路由存在性。
  const sessions = new SessionService();
  app.register(authRoutes, {
    prefix: '/api/auth',
    enabled: Boolean(options.accessPassword),
    passwordHash: options.accessPassword
      ? createHash('sha256').update(options.accessPassword).digest()
      : undefined,
    sessions,
  });
  if (options.accessPassword) {
    // 公开端点：登录/登出/状态探测，以及健康检查（uTools preload 的 healthCheck 依赖它）。
    const PUBLIC = new Set([
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/status',
      '/api/health',
    ]);
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const [pathname, query = ''] = request.url.split('?');
      if (!pathname.startsWith('/api/') || PUBLIC.has(pathname)) return;
      const auth = request.headers.authorization;
      const token = auth?.startsWith('Bearer ')
        ? auth.slice('Bearer '.length)
        : (new URLSearchParams(query).get('access_token') ?? undefined);
      if (token && sessions.validate(token)) return;
      return reply.code(401).send(errorPayload('unauthorized', 'Authentication required'));
    });
  }

  // 工具调用审批中枢 + Plan 模式服务：都以"内联扩展"注入每个会话，
  // 闭包直接引用这两个实例（不走事件总线），挂起等待由 broker 的 Promise 结算。
  const approvals = new ToolApprovalBroker();
  const plans = options.planService ?? new PlanModeService();

  const agentDir =
    options.agentDir ?? `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}/.pi/agent`;

  // MCP 服务：进程级单例，持有 MCP server 配置读写 + 连接池（多个会话共享连接）。
  // 注入给 OriginalPiSessionFactory，其 loader() 会把它包装成内联扩展注入每个会话。
  // app.log（logger:false 时为静默实现）同时作为 MCP 连接/工具调用的日志器。
  const mcpService =
    options.mcpService ?? new McpService(new McpConfig(agentDir), undefined, app.log);

  // 平台存储与可观测性账本（M1）。
  // 默认策略：**不传 trace 配置就不写盘**（createApp() 的测试环境绝不触碰真实 ~/.pi），
  // 生产由 server.ts 传 config.trace（默认 enabled=true + sqlite）。
  // trace 关闭时仍提供一个空存储，让 REST 契约保持可用（返回空集）。
  const traceEnabled = options.store !== undefined || options.trace?.enabled === true;
  const store =
    options.store ??
    (traceEnabled
      ? openPlatformStore({
          mode: options.trace?.mode ?? 'sqlite',
          ...(options.trace?.dbPath === undefined ? {} : { dbPath: options.trace.dbPath }),
          ...(options.trace?.flushMs === undefined ? {} : { flushMs: options.trace.flushMs }),
          ...(options.trace?.batchSize === undefined ? {} : { batchSize: options.trace.batchSize }),
          ...(options.trace?.maxPending === undefined
            ? {}
            : { maxPending: options.trace.maxPending }),
          logger: app.log,
        })
      : openNullStore());
  const ledger = traceEnabled
    ? new SessionLedger(store.traces, app.log, { content: options.trace?.content === true })
    : undefined;

  // 装配核心依赖（每个都支持外部注入覆盖，见 AppOptions）：
  // - AgentRegistry：会话注册表，管理所有活跃 Pi 会话 + SSE 事件缓存；
  // - WorkspaceService：工作区登记与 JSON 持久化；
  // - ModelCatalogService / ModelConfigService：模型目录与 models.json 配置；
  // - FileService：工作区文件浏览/预览（带路径越权保护）；
  // - SkillService：技能列表与开关。
  const registry =
    options.registry ??
    new AgentRegistry(
      // OriginalPiSessionFactory 是 Pi SDK 的适配器，负责真正创建/打开 AgentSession；
      // agentDir 默认指向用户主目录下的 ~/.pi/agent。
      // 传入 mcpService/approvals/plans，loader 把它们包装成内联扩展注入每个会话
      // （闭包直连实例，共享 MCP 连接与审批中枢，支持按预设开关）。
      // 第 4 参 app.log：会话事件（模型请求/响应、工具执行）的结构化日志器。
      new OriginalPiSessionFactory(agentDir, mcpService, approvals, plans, app.log, ledger),
      approvals,
      plans,
      app.log,
      ledger,
    );
  const workspaceService =
    options.workspaceService ??
    new WorkspaceService(options.workspaceParent, join(agentDir, 'node-server-workspaces.json'));
  const modelCatalogService =
    options.modelCatalogService ?? new ModelCatalogService(agentDir, process.cwd());
  const modelConfigService = options.modelConfigService ?? new ModelConfigService(agentDir);
  const presetService = options.presetService ?? new PresetService(agentDir);
  const fileService = new FileService(workspaceService);
  const skillService = new SkillService(agentDir, workspaceService);

  // 全局错误处理器：任何路由处理函数 throw 的错误（包括 async 函数里
  // reject 的 Promise）最终都会到这里，由 Fastify 自动派发。
  // - 业务错误（ApiError）→ 返回它携带的状态码和错误体；
  // - 其他未知错误 → 记录日志并统一返回 500，避免向客户端泄露内部信息。
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send(errorPayload(error.code, error.message, error.details));
    }
    request.log.error(error);
    return reply.code(500).send(errorPayload('internal_error', 'Internal server error'));
  });

  // onReady 钩子：在 app.listen() 真正开始监听之前执行。
  // 用途：从持久化文件恢复用户登记过的工作区目录（见 workspace-service.ts）。
  app.addHook('onReady', async () => workspaceService.initialize());

  // 健康检查端点，供部署探活 / 前端判断后端是否就绪。
  app.get('/api/health', async () => ({ status: 'ok' }));

  // 挂载各业务路由插件。
  // Fastify 的 prefix 选项会给插件内所有路由统一加上路径前缀，例如
  // agent.ts 里的 "/new" 实际对外是 POST /api/agent/new。
  app.register(agentRoutes, { prefix: '/api/agent', registry });
  app.register(sessionRoutes, { prefix: '/api/sessions', registry });
  app.register(fileRoutes, { prefix: '/api/files', service: fileService });
  // 下面三个插件未使用 prefix，路径在插件内部写全（如 /api/models、/api/home），
  // 两种风格都可以，保持与 FastAPI 后端相同的对外路径即可。
  app.register(workspaceRoutes, { service: workspaceService });
  app.register(modelRoutes, {
    service: modelCatalogService,
    configService: modelConfigService,
    registry,
  });
  app.register(skillRoutes, { service: skillService, registry });
  app.register(mcpRoutes, { prefix: '/api/mcp', service: mcpService, registry });
  app.register(presetRoutes, { prefix: '/api/presets', service: presetService });
  app.register(observabilityRoutes, {
    prefix: '/api/observability',
    traces: store.traces,
    stats: () => store.stats(),
  });

  // 前端静态托管：web 构建产物（默认 ../../web/dist）。显式 /api 路由优先于
  // @fastify/static 的 wildcard 路由，故不影响 API；找不到文件会触发下面的
  // setNotFoundHandler：非 /api 的 GET 回退到 index.html（SPA 客户端路由），
  // 其余路径保持 Fastify 默认的 404 JSON 响应。
  if (options.webDistDir) {
    if (existsSync(options.webDistDir)) {
      app.register(fastifyStatic, { root: options.webDistDir });
      app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && !request.url.startsWith('/api/')) {
          return reply.type('text/html').sendFile('index.html');
        }
        return reply
          .code(404)
          .type('application/json')
          .send({ message: `Route ${request.method}:${request.url} not found` });
      });
    } else {
      app.log.warn(`web dist not found at ${options.webDistDir}; serving API only`);
    }
  }

  // onClose 钩子：服务关闭（Ctrl+C、进程退出等）时释放所有活跃 Pi 会话，
  // 包括取消事件订阅、中止还在流式输出的会话、清理待审批的工具调用。
  // PlanModeService 也订阅了事件总线，关闭时一并释放，避免测试/热重启遗留监听器。
  app.addHook('onClose', async () => {
    await registry.close();
    plans.dispose();
    await mcpService.dispose();
    // 最后关闭存储：registry.close() 会把未结算的 run 收尾写进队列，close() 再落盘。
    store.close();
  });

  return app;
}

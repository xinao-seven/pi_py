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

import { createEventBus } from "@earendil-works/pi-coding-agent";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";

import { ApiError, errorPayload } from "./errors.js";
import { agentRoutes } from "./routes/agent.js";
import { fileRoutes } from "./routes/files.js";
import { modelRoutes } from "./routes/models.js";
import { sessionRoutes } from "./routes/sessions.js";
import { skillRoutes } from "./routes/skills.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { AgentRegistry, OriginalPiSessionFactory } from "./services/agent-registry.js";
import { FileService } from "./services/file-service.js";
import { ModelCatalogService } from "./services/model-catalog.js";
import { ModelConfigService } from "./services/model-config-service.js";
import { SkillService } from "./services/skill-service.js";
import { ToolApprovalBroker } from "./services/tool-approval.js";
import { PlanModeService } from "./services/plan-mode-service.js";
import { WorkspaceService } from "./services/workspace-service.js";

/**
 * createApp 的可选依赖注入参数。
 * 中文说明：测试时可以传入 mock 的 registry / service，避免真实读取
 * Pi 配置文件或真实操作文件系统；不传则使用生产默认实现。
 */
export interface AppOptions {
  agentDir?: string;                 // Pi agent 数据目录（auth.json / models.json / sessions/）
  registry?: AgentRegistry;          // 会话注册表（活跃 Pi 会话 + SSE 事件缓存）
  workspaceParent?: string;          // 默认工作区父目录
  workspaceService?: WorkspaceService;     // 工作区登记与持久化
  modelCatalogService?: ModelCatalogService; // 模型目录（从 Pi SDK 读取）
  modelConfigService?: ModelConfigService;   // models.json 读写
  planService?: PlanModeService;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  // Fastify({ logger: false }) 创建应用实例；这里关闭内置日志（开发启动器自行打印）。
  // 注意：app 同时也是一个"根插件封装"，后面所有 register 都挂在它下面，
  // 形成一个封装树（Fastify 的 Encapsulation 机制）。
  const app = Fastify({ logger: false });

  // 注册 @fastify/cors 插件：origin: true 表示"反射请求来源"（即允许任意来源）。
  // 原因：uTools 插件以 file:// 或 utools:// 协议发起请求，没有标准 Origin 头；
  // 反射模式能放行这类客户端，并自动处理 JSON POST 的 CORS 预检（OPTIONS 请求）。
  app.register(cors, { origin: true });

  // 工具调用审批中枢：Pi 的 bash 工具在命中危险命令规则时，会通过它
  // 挂起等待，直到前端在 SSE 流上收到 tool_call_pending 事件后做出审批。
  // 扩展与服务器不共享模块实例（jiti 隔离），所以用同一个事件总线联动：
  // 同一实例同时注入 OriginalPiSessionFactory（成为扩展的 pi.events）与 broker。
  const eventBus = createEventBus();
  const approvals = new ToolApprovalBroker(eventBus);
  const plans = options.planService ?? new PlanModeService(eventBus);

  // 装配核心依赖（每个都支持外部注入覆盖，见 AppOptions）：
  // - AgentRegistry：会话注册表，管理所有活跃 Pi 会话 + SSE 事件缓存；
  // - WorkspaceService：工作区登记与 JSON 持久化；
  // - ModelCatalogService / ModelConfigService：模型目录与 models.json 配置；
  // - FileService：工作区文件浏览/预览（带路径越权保护）；
  // - SkillService：技能列表与开关。
  const registry = options.registry ?? new AgentRegistry(
    // OriginalPiSessionFactory 是 Pi SDK 的适配器，负责真正创建/打开 AgentSession；
    // agentDir 默认指向用户主目录下的 ~/.pi/agent。
    // 传入 eventBus（扩展的 pi.events 也指向它），审批扩展才能与 broker 联动。
    new OriginalPiSessionFactory(options.agentDir ?? `${process.env.USERPROFILE ?? process.env.HOME ?? "."}/.pi/agent`, eventBus),
    approvals,
    plans,
  );
  const agentDir = options.agentDir ?? `${process.env.USERPROFILE ?? process.env.HOME ?? "."}/.pi/agent`;
  const workspaceService = options.workspaceService ?? new WorkspaceService(options.workspaceParent, join(agentDir, "node-server-workspaces.json"));
  const modelCatalogService = options.modelCatalogService ?? new ModelCatalogService(agentDir, process.cwd());
  const modelConfigService = options.modelConfigService ?? new ModelConfigService(agentDir);
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
    return reply.code(500).send(errorPayload("internal_error", "Internal server error"));
  });

  // onReady 钩子：在 app.listen() 真正开始监听之前执行。
  // 用途：从持久化文件恢复用户登记过的工作区目录（见 workspace-service.ts）。
  app.addHook("onReady", async () => workspaceService.initialize());

  // 健康检查端点，供部署探活 / 前端判断后端是否就绪。
  app.get("/api/health", async () => ({ status: "ok" }));

  // 挂载各业务路由插件。
  // Fastify 的 prefix 选项会给插件内所有路由统一加上路径前缀，例如
  // agent.ts 里的 "/new" 实际对外是 POST /api/agent/new。
  app.register(agentRoutes, { prefix: "/api/agent", registry });
  app.register(sessionRoutes, { prefix: "/api/sessions", registry });
  app.register(fileRoutes, { prefix: "/api/files", service: fileService });
  // 下面三个插件未使用 prefix，路径在插件内部写全（如 /api/models、/api/home），
  // 两种风格都可以，保持与 FastAPI 后端相同的对外路径即可。
  app.register(workspaceRoutes, { service: workspaceService });
  app.register(modelRoutes, { service: modelCatalogService, configService: modelConfigService, registry });
  app.register(skillRoutes, { service: skillService, registry });

  // onClose 钩子：服务关闭（Ctrl+C、进程退出等）时释放所有活跃 Pi 会话，
  // 包括取消事件订阅、中止还在流式输出的会话、清理待审批的工具调用。
  // PlanModeService 也订阅了事件总线，关闭时一并释放，避免测试/热重启遗留监听器。
  app.addHook("onClose", async () => {
    await registry.close();
    plans.dispose();
  });

  return app;
}

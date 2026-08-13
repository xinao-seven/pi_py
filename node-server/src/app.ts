/** Fastify application factory.
 *
 * 中文说明：应用工厂集中装配路由、日志与统一错误处理；后续 Pi Session 服务通过
 * Fastify 插件挂载，避免 HTTP 路由直接依赖 Pi SDK 细节。
 */

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
import { WorkspaceService } from "./services/workspace-service.js";

export interface AppOptions {
  agentDir?: string;
  registry?: AgentRegistry;
  workspaceParent?: string;
  workspaceService?: WorkspaceService;
  modelCatalogService?: ModelCatalogService;
  modelConfigService?: ModelConfigService;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  // 仅监听 loopback，无鉴权；反射请求来源以允许 uTools 插件（file:// / utools://）
  // 等跨域客户端访问，并自动处理 JSON POST 的 CORS 预检（OPTIONS）。
  app.register(cors, { origin: true });
  const approvals = new ToolApprovalBroker();
  const registry = options.registry ?? new AgentRegistry(
    new OriginalPiSessionFactory(options.agentDir ?? `${process.env.USERPROFILE ?? process.env.HOME ?? "."}/.pi/agent`, approvals),
    approvals,
  );
  const agentDir = options.agentDir ?? `${process.env.USERPROFILE ?? process.env.HOME ?? "."}/.pi/agent`;
  const workspaceService = options.workspaceService ?? new WorkspaceService(options.workspaceParent, join(agentDir, "node-server-workspaces.json"));
  const modelCatalogService = options.modelCatalogService ?? new ModelCatalogService(agentDir, process.cwd());
  const modelConfigService = options.modelConfigService ?? new ModelConfigService(agentDir);
  const fileService = new FileService(workspaceService);
  const skillService = new SkillService(agentDir, workspaceService);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send(errorPayload(error.code, error.message, error.details));
    }
    request.log.error(error);
    return reply.code(500).send(errorPayload("internal_error", "Internal server error"));
  });

  app.addHook("onReady", async () => workspaceService.initialize());
  app.get("/api/health", async () => ({ status: "ok" }));
  app.register(agentRoutes, { prefix: "/api/agent", registry });
  app.register(sessionRoutes, { prefix: "/api/sessions", registry });
  app.register(fileRoutes, { prefix: "/api/files", service: fileService });
  app.register(workspaceRoutes, { service: workspaceService });
  app.register(modelRoutes, { service: modelCatalogService, configService: modelConfigService, registry });
  app.register(skillRoutes, { service: skillService, registry });
  app.addHook("onClose", async () => registry.close());

  return app;
}

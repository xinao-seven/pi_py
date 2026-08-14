/**
 * 模型目录与模型配置路由。
 *
 * 中文说明：返回当前 Vue 已使用的 ModelCatalog JSON 结构（与 Python 后端一致的
 * models / modelList / defaultModel / thinkingLevels / thinkingLevelMaps），
 * 并提供 models.json 配置的读写接口。
 *
 * Fastify 概念：
 * - GET 路由直接 return 对象即可自动 JSON 序列化；
 * - PUT 路由的 request.body 就是请求体（默认已按 JSON 解析），
 *   写配置是"整体替换"，所以这里不需要 id 之类的路径参数。
 */

import type { FastifyPluginAsync } from "fastify";

import { ModelCatalogService } from "../services/model-catalog.js";
import { ModelConfigService } from "../services/model-config-service.js";
import { AgentRegistry } from "../services/agent-registry.js";

/** 插件选项：三个依赖，均来自 app.ts 装配（测试可注入 mock）。 */
export interface ModelRouteOptions {
  service: ModelCatalogService;      // 读取 Pi SDK 的模型目录
  configService: ModelConfigService; // 读写 models.json
  registry: AgentRegistry;           // 用于热重载模型运行时
}

export const modelRoutes: FastifyPluginAsync<ModelRouteOptions> = async (app, options) => {
  // GET /api/models —— 模型目录（前端模型选择器数据源）。
  app.get("/api/models", async () => options.service.catalog());

  // GET /api/models-config —— 返回当前 models.json 的净化副本（只含允许的字段）。
  app.get("/api/models-config", async () => options.configService.read());

  // PUT /api/models-config —— 整体替换 models.json。
  // 写完后需要让下游立即感知：
  // 1) 模型目录缓存失效（下次 GET /api/models 重新读）；
  // 2) 所有活跃会话的模型运行时重载（registry.reloadModelRuntime()）。
  app.put("/api/models-config", async (request) => {
    await options.configService.write(request.body);
    options.service.invalidate();
    options.registry.reloadModelRuntime();
    return { success: true };
  });
};

/** Model catalog route.
 *
 * 中文说明：返回当前 Vue 已使用的 ModelCatalog JSON 结构。
 */

import type { FastifyPluginAsync } from "fastify";

import { ModelCatalogService } from "../services/model-catalog.js";
import { ModelConfigService } from "../services/model-config-service.js";
import { AgentRegistry } from "../services/agent-registry.js";

export interface ModelRouteOptions {
  service: ModelCatalogService;
  configService: ModelConfigService;
  registry: AgentRegistry;
}

export const modelRoutes: FastifyPluginAsync<ModelRouteOptions> = async (app, options) => {
  app.get("/api/models", async () => options.service.catalog());
  app.get("/api/models-config", async () => options.configService.read());
  app.put("/api/models-config", async (request) => {
    await options.configService.write(request.body);
    options.service.invalidate();
    options.registry.reloadModelRuntime();
    return { success: true };
  });
};

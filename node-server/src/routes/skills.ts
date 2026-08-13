import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../errors.js";
import { AgentRegistry } from "../services/agent-registry.js";
import { SkillService } from "../services/skill-service.js";

export const skillRoutes: FastifyPluginAsync<{ service: SkillService; registry: AgentRegistry }> = async (app, options) => {
  app.get<{ Querystring: { cwd?: string } }>("/api/skills", async (request) => {
    if (!request.query.cwd) throw new ApiError(422, "validation_error", "cwd is required");
    return options.service.list(request.query.cwd);
  });
  app.patch<{ Body: { filePath?: unknown; disableModelInvocation?: unknown } }>("/api/skills", async (request) => {
    const { filePath, disableModelInvocation } = request.body ?? {};
    if (typeof filePath !== "string" || typeof disableModelInvocation !== "boolean") {
      throw new ApiError(422, "validation_error", "filePath and disableModelInvocation are required");
    }
    await options.service.toggle(filePath, disableModelInvocation);
    await options.registry.reloadResources();
    return { success: true };
  });
};

/** Workspace routes shared by the existing Vue picker.
 *
 * 中文说明：接口字段与 FastAPI 后端保持一致，Vue 不需要区分当前使用哪个后端。
 */

import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../errors.js";
import { WorkspaceService } from "../services/workspace-service.js";

export interface WorkspaceRouteOptions {
  service: WorkspaceService;
}

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRouteOptions> = async (app, options) => {
  app.get("/api/home", async () => ({ home: options.service.parent }));
  app.get("/api/workspaces", async () => ({ workspaces: await options.service.roots() }));
  app.post("/api/default-cwd", async () => ({ cwd: await options.service.createDefault() }));
  app.post("/api/workspaces/pick", async () => ({ cwd: await options.service.pickDirectory() ?? null }));
  app.post("/api/workspaces/select", async (request) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body) || typeof (body as { cwd?: unknown }).cwd !== "string") {
      throw new ApiError(422, "validation_error", "cwd must be a string");
    }
    return { cwd: await options.service.select((body as { cwd: string }).cwd) };
  });
};

/**
 * 工作区（Workspace）路由，供现有 Vue 的目录选择器使用。
 *
 * 中文说明：接口字段与 FastAPI 后端保持一致，Vue 不需要区分当前使用哪个后端。
 * 核心能力：查询用户主目录、列出已登记的工作区、创建默认工作区、
 * 弹系统目录选择器（Windows）、以及登记/选择某个工作区。
 *
 * Fastify 概念：这些路由都注册在根路径下（未使用 prefix），
 * 路径在插件内部写全（/api/home 等）；handler 里 return 的对象自动 JSON 化。
 */

import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../errors.js";
import { WorkspaceService } from "../services/workspace-service.js";

/** 插件选项：工作区服务。 */
export interface WorkspaceRouteOptions {
  service: WorkspaceService;
}

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRouteOptions> = async (app, options) => {
  // GET /api/home —— 返回默认工作区父目录（配置的 workspaceParent，通常是用户主目录）。
  app.get("/api/home", async () => ({ home: options.service.parent }));

  // GET /api/workspaces —— 列出所有已登记且仍然存在的本地工作区目录。
  app.get("/api/workspaces", async () => ({ workspaces: await options.service.roots() }));

  // POST /api/default-cwd —— 在父目录下按日期创建默认工作区（如 pi-cwd-20250701），
  // 并自动登记。首次使用、还没选择目录时前端会调用它。
  app.post("/api/default-cwd", async () => ({ cwd: await options.service.createDefault() }));

  // POST /api/workspaces/pick —— 弹出 Windows 原生"选择文件夹"对话框，
  // 用户取消时返回 { cwd: null }。
  app.post("/api/workspaces/pick", async () => ({ cwd: await options.service.pickDirectory() ?? null }));

  // POST /api/workspaces/select —— 登记一个已存在的本地目录为工作区。
  // body: { cwd: "<绝对路径>" }，路径不存在或不是目录会抛 400。
  app.post("/api/workspaces/select", async (request) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body) || typeof (body as { cwd?: unknown }).cwd !== "string") {
      throw new ApiError(422, "validation_error", "cwd must be a string");
    }
    return { cwd: await options.service.select((body as { cwd: string }).cwd) };
  });
};

/**
 * 任务 REST 路由（M2）。
 *
 * 中文说明：薄适配层——参数校验与整形都在 `TaskService` 里，这里只负责把 HTTP
 * 请求翻译成服务调用，并把结果包成前端期望的结构。对外契约（规划 §4.2.2）：
 *
 *   GET    /api/tasks?status&sessionId&cwd&limit
 *   POST   /api/tasks
 *   GET    /api/tasks/:taskId
 *   PATCH  /api/tasks/:taskId                     （必须带 ifRevision）
 *   POST   /api/tasks/:taskId/cancel
 *   POST   /api/tasks/:taskId/steps
 *   PATCH  /api/tasks/:taskId/steps/:stepId
 *   DELETE /api/tasks/:taskId/steps/:stepId?force=true
 *
 * 所有成功响应都返回**整条任务**（`{ task }`），让前端无需自己合并增量；
 * 列表返回 `{ tasks }`。并发冲突统一是 409 `task_conflict`（带 currentRevision）。
 *
 * M3 才会加的接口（`/resume`、`/recovery`）故意**不在这里占位**——半成品接口会让
 * 调用方误以为功能已经存在。`execution`（租约/心跳）字段已经随任务返回。
 */

import type { FastifyPluginAsync } from 'fastify';

import { ApiError } from '../errors.js';
import type { TaskService } from '../services/task-service.js';

export interface TaskRouteOptions {
  service: TaskService;
}

/** 校验并取出请求体（必须是普通对象）。 */
function bodyOf(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(422, 'validation_error', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** 任务路由插件：对外路径以 /api/tasks 开头。 */
export const taskRoutes: FastifyPluginAsync<TaskRouteOptions> = async (app, options) => {
  // GET /api/tasks —— 列表（按 updatedAt 倒序）。
  app.get<{ Querystring: Record<string, unknown> }>('/', async (request) => {
    return { tasks: options.service.list(request.query) };
  });

  // POST /api/tasks —— 新建任务（steps 可选）。
  app.post<{ Body: unknown }>('/', async (request) => {
    const body = bodyOf(request.body);
    return {
      task: options.service.create({
        title: body.title as string,
        goal: body.goal as string,
        ...(body.origin === undefined ? {} : { origin: body.origin as 'user' | 'plan' }),
        ...(body.sessionId === undefined ? {} : { sessionId: String(body.sessionId) }),
        ...(body.cwd === undefined ? {} : { cwd: String(body.cwd) }),
        ...(body.steps === undefined
          ? {}
          : { steps: body.steps as Parameters<TaskService['create']>[0]['steps'] }),
      }),
    };
  });

  // GET /api/tasks/:taskId —— 详情。
  app.get<{ Params: { taskId: string } }>('/:taskId', async (request) => {
    return { task: options.service.get(request.params.taskId) };
  });

  // PATCH /api/tasks/:taskId —— 改标题/目标/状态/原因/结论（带 ifRevision）。
  app.patch<{ Params: { taskId: string }; Body: unknown }>('/:taskId', async (request) => {
    const body = bodyOf(request.body);
    return { task: options.service.update(request.params.taskId, body) };
  });

  // POST /api/tasks/:taskId/cancel —— 取消（终态，幂等；可带 ifRevision/reason）。
  app.post<{ Params: { taskId: string }; Body: unknown }>('/:taskId/cancel', async (request) => {
    const body = request.body === undefined || request.body === null ? {} : bodyOf(request.body);
    return { task: options.service.cancel(request.params.taskId, body) };
  });

  // POST /api/tasks/:taskId/steps —— 追加步骤。
  app.post<{ Params: { taskId: string }; Body: unknown }>('/:taskId/steps', async (request) => {
    const body = bodyOf(request.body);
    return { task: options.service.addStep(request.params.taskId, body as never) };
  });

  // PATCH /api/tasks/:taskId/steps/:stepId —— 改步骤状态/文案/顺序/证据。
  app.patch<{ Params: { taskId: string; stepId: string }; Body: unknown }>(
    '/:taskId/steps/:stepId',
    async (request) => {
      const body = bodyOf(request.body);
      return {
        task: options.service.updateStep(request.params.taskId, request.params.stepId, body),
      };
    },
  );

  // DELETE /api/tasks/:taskId/steps/:stepId —— 删除步骤（已完成的需 force=true）。
  app.delete<{
    Params: { taskId: string; stepId: string };
    Querystring: { force?: string };
    Body: unknown;
  }>('/:taskId/steps/:stepId', async (request) => {
    const body = request.body === undefined || request.body === null ? {} : bodyOf(request.body);
    return {
      task: options.service.removeStep(request.params.taskId, request.params.stepId, {
        ...body,
        force: request.query.force === 'true' || body.force === true,
      }),
    };
  });
};

/**
 * 任务 REST 路由（M2）。
 *
 * 中文说明：薄适配层——参数校验与整形都在 `TaskService` 里，这里只负责把 HTTP
 * 请求翻译成服务调用，并把结果包成前端期望的结构。对外契约（规划 §4.2.2）：
 *
 *   GET    /api/tasks?status&sessionId&cwd&limit
 *   GET    /api/tasks/recovery                   （M3：重启后待恢复清单）
 *   POST   /api/tasks
 *   GET    /api/tasks/:taskId
 *   PATCH  /api/tasks/:taskId                     （必须带 ifRevision）
 *   POST   /api/tasks/:taskId/cancel
 *   POST   /api/tasks/:taskId/resume              （M3：202，长任务走 SSE）
 *   POST   /api/tasks/:taskId/steps
 *   PATCH  /api/tasks/:taskId/steps/:stepId
 *   DELETE /api/tasks/:taskId/steps/:stepId?force=true
 *
 * 所有成功响应都返回**整条任务**（`{ task }`），让前端无需自己合并增量；
 * 列表返回 `{ tasks }`。并发冲突统一是 409 `task_conflict`（带 currentRevision）。
 *
 * M3 的 `resume` 依赖恢复服务的判定：需要人工确认（未知副作用 / 无法验证的写）时会返回
 * 409 `task_needs_confirmation`，调用方带 `confirmSideEffect: true` 重试才放行——
 * 宁可不跑，也不能重复副作用。`replan` 仍留给 M4。
 */

import type { FastifyPluginAsync } from 'fastify';

import { ApiError } from '../errors.js';
import type { TaskRecoveryService, ResumeRequest } from '../services/task-recovery.js';
import type { TaskRunner } from '../services/task-runner.js';
import type { TaskService } from '../services/task-service.js';

export interface TaskRouteOptions {
  service: TaskService;
  /** M3：恢复清单与续跑。不提供时 /recovery 与 /resume 不可用（旧调用方/测试兼容）。 */
  recovery?: TaskRecoveryService;
  runner?: TaskRunner;
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

  // GET /api/tasks/recovery —— 重启后待恢复清单（只读，不自动执行）。
  app.get('/recovery', async () => {
    if (!options.recovery) {
      throw new ApiError(409, 'recovery_unavailable', 'Task recovery is not available');
    }
    return { tasks: options.recovery.scan() };
  });

  // POST /api/tasks/:taskId/resume —— 续跑（202：长任务，过程走 SSE）。
  app.post<{ Params: { taskId: string }; Body: unknown }>(
    '/:taskId/resume',
    async (request, reply) => {
      if (!options.runner || !options.recovery) {
        throw new ApiError(409, 'recovery_unavailable', 'Task recovery is not available');
      }
      const body = request.body === undefined || request.body === null ? {} : bodyOf(request.body);
      const mode = body.mode ?? 'continue';
      if (mode !== 'continue' && mode !== 'retry_step' && mode !== 'replan') {
        throw new ApiError(
          422,
          'validation_error',
          'mode must be one of: continue, retry_step, replan',
        );
      }
      const resumeRequest: ResumeRequest = {
        mode,
        ...(body.confirmSideEffect === true ? { confirmSideEffect: true } : {}),
      };
      const outcome = await options.runner.resume(request.params.taskId, resumeRequest);
      return reply.code(202).send({
        ok: true,
        task: outcome.task,
        recovery: outcome.item,
        mode: resumeRequest.mode,
      });
    },
  );

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

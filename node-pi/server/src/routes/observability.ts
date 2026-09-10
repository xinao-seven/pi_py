/**
 * 可观测性 REST 路由（M1）。
 *
 * 中文说明：薄适配层——只做参数校验与整形，业务都在 observability/metrics.ts 与
 * platform/ 存储层。对外契约（见 docs/node-platform-plan.md §4.1.4）：
 *
 *   GET    /api/observability/summary?from&to&cwd
 *   GET    /api/observability/runs?sessionId&taskId&limit&cursor
 *   GET    /api/observability/runs/:runId
 *   DELETE /api/observability/runs?before=<iso>
 *
 * 时间参数同时接受 ISO 字符串与毫秒时间戳；非法参数一律 422 validation_error。
 */

import type { FastifyPluginAsync } from 'fastify';

import { ApiError } from '../errors.js';
import {
  buildSummary,
  serializeRun,
  serializeRunDetail,
} from '../services/observability/metrics.js';
import type { TraceReader, TraceStoreStats } from '../services/platform/trace-repository.js';
import type { RunQuery, TraceQuery } from '../services/platform/trace-model.js';

/** 默认返回条数（runs 列表）。 */
const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 500;

export interface ObservabilityRouteOptions {
  traces: TraceReader;
  /** trace 存储健康状态（关闭/降级时面板要能看出来）。 */
  stats?: () => TraceStoreStats;
}

/** 解析时间参数：ISO 字符串或毫秒时间戳。 */
function parseTime(value: unknown, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ApiError(422, 'validation_error', `${field} must be an ISO timestamp or epoch ms`);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ApiError(422, 'validation_error', `${field} must be an ISO timestamp or epoch ms`);
  }
  return parsed;
}

/** 解析可选字符串参数（空串视为未提供）。 */
function parseText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === '') return DEFAULT_RUN_LIMIT;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_RUN_LIMIT) {
    throw new ApiError(
      422,
      'validation_error',
      `limit must be an integer from 1 to ${MAX_RUN_LIMIT}`,
    );
  }
  return numeric;
}

/** 把 query string 里的可观测性过滤参数解析成 TraceQuery。 */
function traceQuery(query: Record<string, unknown>): TraceQuery {
  const from = parseTime(query.from, 'from');
  const to = parseTime(query.to, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    throw new ApiError(422, 'validation_error', 'from must not be later than to');
  }
  const cwd = parseText(query.cwd);
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** 可观测性路由插件：对外路径以 /api/observability 开头。 */
export const observabilityRoutes: FastifyPluginAsync<ObservabilityRouteOptions> = async (
  app,
  options,
) => {
  // GET /api/observability/summary —— Dashboard 的汇总数据（成本/p95/成功率/审批命中）。
  app.get<{ Querystring: Record<string, unknown> }>('/summary', async (request) => {
    const data = options.traces.summary(traceQuery(request.query));
    return buildSummary(data, options.stats?.());
  });

  // GET /api/observability/runs —— run 列表（键集分页，按开始时间倒序）。
  app.get<{ Querystring: Record<string, unknown> }>('/runs', async (request) => {
    const query: RunQuery = {
      ...traceQuery(request.query),
      limit: parseLimit(request.query.limit),
    };
    const sessionId = parseText(request.query.sessionId);
    const taskId = parseText(request.query.taskId);
    const cursor = parseText(request.query.cursor);
    if (sessionId !== undefined) query.sessionId = sessionId;
    if (taskId !== undefined) query.taskId = taskId;
    if (cursor !== undefined) query.cursor = cursor;
    const result = options.traces.listRuns(query);
    return {
      runs: result.runs.map(serializeRun),
      nextCursor: result.nextCursor ?? null,
    };
  });

  // GET /api/observability/runs/:runId —— run 详情（含 steps 与子 run）。
  app.get<{ Params: { runId: string } }>('/runs/:runId', async (request) => {
    const detail = options.traces.getRun(request.params.runId);
    if (!detail) {
      throw new ApiError(404, 'run_not_found', `Run ${request.params.runId} was not found`);
    }
    return serializeRunDetail(detail);
  });

  // DELETE /api/observability/runs?before=<iso> —— 清理 before 之前的明细。
  // 中文说明：预聚合表不随明细清理，因此历史累计口径完整保留（只是下钻不到被清理的 run）。
  app.delete<{ Querystring: Record<string, unknown> }>('/runs', async (request) => {
    const before = parseTime(request.query.before, 'before');
    if (before === undefined) {
      throw new ApiError(422, 'validation_error', 'before is required');
    }
    return { ok: true, deletedRuns: options.traces.prune(before) };
  });
};

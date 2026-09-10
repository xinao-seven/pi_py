import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { openPlatformStore, type PlatformStore } from '../../src/services/platform/store.js';
import type { RunRow, StepRow } from '../../src/services/platform/trace-model.js';

const DAY = Date.UTC(2026, 7, 20, 10, 0, 0);

const stores: PlatformStore[] = [];
const apps: ReturnType<typeof createApp>[] = [];

function memoryStore(): PlatformStore {
  const store = openPlatformStore({ mode: 'memory' });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  while (stores.length) {
    try {
      stores.pop()!.close();
    } catch {
      // 已关闭：忽略
    }
  }
});

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    cwd: '/workspace',
    provider: 'deepseek',
    model: 'deepseek-chat',
    startedAt: DAY,
    status: 'running',
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

function toolStep(overrides: Partial<StepRow> = {}): StepRow {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnIndex: 1,
    kind: 'tool_call',
    toolName: 'bash',
    toolCallId: 'call-1',
    startedAt: DAY + 100,
    endedAt: DAY + 200,
    durationMs: 100,
    isError: false,
    ...overrides,
  };
}

/** 造一次「成功 run + 一次被审批拦下的 bash 调用」。 */
function seed(store: PlatformStore): void {
  store.traces.startRun(run());
  store.traces.addStep(toolStep());
  store.traces.addStep(
    toolStep({
      toolCallId: 'call-2',
      durationMs: 0,
      isError: true,
      blockedBy: 'approval',
    }),
  );
  store.traces.addStep(
    toolStep({
      kind: 'approval',
      toolName: undefined,
      toolCallId: 'call-2',
      durationMs: 900,
      isError: false,
      approvalRule: 'recursive-delete',
      approvalRisk: 'critical',
      approvalDecision: 'denied',
      approvalWaitMs: 900,
      decidedBy: 'user',
    }),
  );
  store.traces.finishRun('run-1', {
    endedAt: DAY + 5_000,
    status: 'completed',
    turns: 2,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    costUsd: 0.012,
    ttftMs: 300,
    durationMs: 5_000,
    stopReason: 'endTurn',
  });
  store.flush();
}

describe('observability REST routes', () => {
  it('serves the summary with totals, tools, approvals and store health', async () => {
    const store = memoryStore();
    seed(store);
    const app = createApp({ store });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/observability/summary' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totals).toMatchObject({
      runs: 1,
      turns: 2,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 50,
      costUsd: 0.012,
      p50DurationMs: 5_000,
      p95DurationMs: 5_000,
      p50TtftMs: 300,
      errorRate: 0,
    });
    expect(body.byTool).toEqual([
      {
        toolName: 'bash',
        calls: 2,
        errors: 0, // 被审批拦下的调用不算工具失败
        blocked: 1,
        errorRate: 0,
        p50DurationMs: 0,
        p95DurationMs: 100,
      },
    ]);
    expect(body.byApproval).toEqual([
      {
        rule: 'recursive-delete',
        risk: 'critical',
        approved: 0,
        denied: 1,
        timedOut: 0,
        p50WaitMs: 900,
      },
    ]);
    expect(body.byModel[0]).toMatchObject({ provider: 'deepseek', runs: 1, tokens: 1_200 });
    expect(body.daily).toEqual([
      { date: '2026-08-20', runs: 1, costUsd: 0.012, inputTokens: 1_000, outputTokens: 200 },
    ]);
    expect(body.store).toMatchObject({ mode: 'memory', degraded: false });
  });

  it('filters the summary by time window and cwd', async () => {
    const store = memoryStore();
    seed(store);
    const app = createApp({ store });
    apps.push(app);

    const windowed = await app.inject({
      method: 'GET',
      url: `/api/observability/summary?from=${new Date(DAY - 1).toISOString()}&to=${new Date(DAY + 1).toISOString()}`,
    });
    expect(windowed.json().totals.runs).toBe(1);

    const empty = await app.inject({
      method: 'GET',
      url: `/api/observability/summary?from=${new Date(DAY + 86_400_000).toISOString()}`,
    });
    expect(empty.json().totals.runs).toBe(0);

    const otherCwd = await app.inject({
      method: 'GET',
      url: '/api/observability/summary?cwd=/nope',
    });
    expect(otherCwd.json().totals.runs).toBe(0);
    expect(otherCwd.json().byTool).toEqual([]);
  });

  it('lists runs with keyset pagination and serves run detail', async () => {
    const store = memoryStore();
    seed(store);
    store.traces.startRun(run({ id: 'run-2', startedAt: DAY + 60_000 }));
    store.traces.finishRun('run-2', {
      endedAt: DAY + 61_000,
      status: 'error',
      turns: 1,
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      durationMs: 1_000,
      errorType: 'model_error',
      errorMessage: 'rate limited',
    });
    store.flush();
    const app = createApp({ store });
    apps.push(app);

    const firstPage = await app.inject({ method: 'GET', url: '/api/observability/runs?limit=1' });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().runs.map((item: { id: string }) => item.id)).toEqual(['run-2']);
    expect(firstPage.json().nextCursor).toBe(`${DAY + 60_000}:run-2`);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/observability/runs?limit=1&cursor=${firstPage.json().nextCursor}`,
    });
    expect(secondPage.json().runs.map((item: { id: string }) => item.id)).toEqual(['run-1']);

    const detail = await app.inject({ method: 'GET', url: '/api/observability/runs/run-1' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run).toMatchObject({ id: 'run-1', status: 'completed', turns: 2 });
    expect(detail.json().steps).toHaveLength(3);
    expect(detail.json().steps[2]).toMatchObject({
      kind: 'approval',
      approvalDecision: 'denied',
      approvalWaitMs: 900,
    });
    expect(detail.json().children).toEqual([]);
  });

  it('validates query parameters and unknown run ids', async () => {
    const store = memoryStore();
    const app = createApp({ store });
    apps.push(app);

    const badTime = await app.inject({
      method: 'GET',
      url: '/api/observability/summary?from=nope',
    });
    expect(badTime.statusCode).toBe(422);
    expect(badTime.json()).toMatchObject({ error: { code: 'validation_error' } });

    const inverted = await app.inject({
      method: 'GET',
      url: `/api/observability/summary?from=${new Date(DAY).toISOString()}&to=${new Date(DAY - 1).toISOString()}`,
    });
    expect(inverted.statusCode).toBe(422);

    const badLimit = await app.inject({ method: 'GET', url: '/api/observability/runs?limit=0' });
    expect(badLimit.statusCode).toBe(422);

    const missing = await app.inject({ method: 'GET', url: '/api/observability/runs/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'run_not_found' } });
  });

  it('prunes details only when before is explicit, keeping aggregates', async () => {
    const store = memoryStore();
    seed(store);
    const app = createApp({ store });
    apps.push(app);

    const noBefore = await app.inject({ method: 'DELETE', url: '/api/observability/runs' });
    expect(noBefore.statusCode).toBe(422);

    const pruned = await app.inject({
      method: 'DELETE',
      url: `/api/observability/runs?before=${new Date(DAY + 30_000).toISOString()}`,
    });
    expect(pruned.statusCode).toBe(200);
    expect(pruned.json()).toEqual({ ok: true, deletedRuns: 1 });

    const gone = await app.inject({ method: 'GET', url: '/api/observability/runs/run-1' });
    expect(gone.statusCode).toBe(404);

    // 预聚合保留：清理明细不影响历史累计口径。
    const summary = await app.inject({ method: 'GET', url: '/api/observability/summary' });
    expect(summary.json().totals.runs).toBe(1);
    expect(summary.json().byTool[0]).toMatchObject({ toolName: 'bash', calls: 2 });
  });

  it('keeps the endpoints usable when tracing is disabled', async () => {
    const app = createApp();
    apps.push(app);

    const summary = await app.inject({ method: 'GET', url: '/api/observability/summary' });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().totals.runs).toBe(0);
    expect(summary.json().store).toMatchObject({ mode: 'off' });

    const runs = await app.inject({ method: 'GET', url: '/api/observability/runs' });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual({ runs: [], nextCursor: null });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addTaskStep,
  cancelTask,
  createTask,
  deleteTaskStep,
  fetchAgentEvents,
  getAuthStatus,
  getObservabilityRun,
  getObservabilitySummary,
  listObservabilityRuns,
  listSessions,
  listTasks,
  pruneObservabilityRuns,
  updateTask,
  updateTaskStep,
} from '@/lib/api';
import { clearToken, setToken, setUnauthorizedHandler } from '@/lib/session';

function jsonResponse(body: unknown, status: number) {
  // 用普通对象模拟 Response，避免依赖测试环境的全局 Response。
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('api request auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearToken();
    setUnauthorizedHandler(() => {});
  });

  it('attaches Authorization Bearer when a token is present', async () => {
    setToken('t0ken');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessions: [] }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await listSessions();

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');
  });

  it('does not attach Authorization when no token is stored', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessions: [] }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await listSessions();

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('fires the unauthorized handler on 401 with code unauthorized', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: 'unauthorized', message: 'Auth required' } }, 401),
        ),
    );

    await expect(listSessions()).rejects.toThrow('Auth required');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not fire the handler on other errors (e.g. wrong password)', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: 'invalid_password', message: 'Invalid password' } }, 401),
        ),
    );

    await expect(getAuthStatus()).rejects.toThrow('Invalid password');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('fetchAgentEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearToken();
  });

  it('attaches Authorization and Last-Event-ID headers, passing the abort signal', async () => {
    setToken('t0ken');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await fetchAgentEvents('s1', 7, controller.signal);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/agent/s1/events');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t0ken');
    expect(headers['Last-Event-ID']).toBe('7');
    expect(init.signal).toBe(controller.signal);
  });

  it('omits Last-Event-ID when resuming from the start (id 0)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await fetchAgentEvents('s1', 0, new AbortController().signal);

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['Last-Event-ID']).toBeUndefined();
  });
});

describe('observability endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearToken();
  });

  it('builds the summary query from range, workspace and cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          totals: {},
          byModel: [],
          byTool: [],
          byApproval: [],
          daily: [],
        },
        200,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getObservabilitySummary({
      from: '2026-08-20T00:00:00.000Z',
      cwd: '/workspace with space',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/observability/summary?from=2026-08-20T00%3A00%3A00.000Z&cwd=%2Fworkspace+with+space',
    );

    fetchMock.mockResolvedValue(jsonResponse({ runs: [], nextCursor: null }, 200));
    await listObservabilityRuns({ limit: 20, sessionId: 's1', cursor: '100:run-1' });
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/observability/runs?sessionId=s1&limit=20&cursor=100%3Arun-1',
    );

    await listObservabilityRuns();
    expect(fetchMock.mock.calls[2][0]).toBe('/api/observability/runs');
  });

  it('fetches a single run and prunes details explicitly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ run: {}, steps: [] }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await getObservabilityRun('run-1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/observability/runs/run-1');

    fetchMock.mockResolvedValue(jsonResponse({ ok: true, deletedRuns: 3 }, 200));
    await expect(pruneObservabilityRuns('2026-08-01T00:00:00.000Z')).resolves.toEqual({
      ok: true,
      deletedRuns: 3,
    });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/observability/runs?before=2026-08-01T00%3A00%3A00.000Z');
    expect(init.method).toBe('DELETE');
  });
});

describe('task endpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearToken();
  });

  it('lists, creates and updates tasks with the revision guard', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ tasks: [] }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await listTasks({ sessionId: 's1', status: 'pending', limit: 20 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tasks?status=pending&sessionId=s1&limit=20');

    fetchMock.mockResolvedValue(jsonResponse({ task: { id: 'task-1', revision: 1 } }, 200));
    await createTask({
      title: '重构 Plan 模式',
      goal: '把正则解析换成结构化工具契约',
      sessionId: 's1',
      steps: [{ title: '第一步' }],
    });
    const [createUrl, createInit] = fetchMock.mock.calls[1];
    expect(createUrl).toBe('/api/tasks');
    expect(createInit.method).toBe('POST');
    expect(JSON.parse(createInit.body as string)).toMatchObject({
      title: '重构 Plan 模式',
      steps: [{ title: '第一步' }],
    });

    await updateTask('task-1', { title: '新标题', ifRevision: 3 });
    const [patchUrl, patchInit] = fetchMock.mock.calls[2];
    expect(patchUrl).toBe('/api/tasks/task-1');
    expect(patchInit.method).toBe('PATCH');
    expect(JSON.parse(patchInit.body as string)).toEqual({ title: '新标题', ifRevision: 3 });
  });

  it('manages steps and cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ task: { id: 'task-1' } }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await addTaskStep('task-1', {
      title: '跑构建',
      verification: { kind: 'command', command: 'npm run build', expectExitCode: 0 },
      ifRevision: 2,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tasks/task-1/steps');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      title: '跑构建',
      ifRevision: 2,
    });

    await updateTaskStep('task-1', 's1', { status: 'completed', ifRevision: 3 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/tasks/task-1/steps/s1');
    expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');

    await deleteTaskStep('task-1', 's1', { ifRevision: 4, force: true });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/tasks/task-1/steps/s1');
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({
      ifRevision: 4,
      force: true,
    });

    await cancelTask('task-1', { ifRevision: 5, reason: '需求取消' });
    expect(fetchMock.mock.calls[3][0]).toBe('/api/tasks/task-1/cancel');
    expect(fetchMock.mock.calls[3][1].method).toBe('POST');

    // 409 task_conflict 会被统一解析成 ApiError（面板据此提示“被其它窗口改过”）。
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'task_conflict', message: 'Task was modified by someone else' } },
        409,
      ),
    );
    await expect(updateTask('task-1', { title: 'x', ifRevision: 1 })).rejects.toMatchObject({
      status: 409,
      code: 'task_conflict',
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
} from '../src/services/agent-registry.js';
import type { PlanModeService } from '../src/services/plan-mode-service.js';
import { PresetService } from '../src/services/preset-service.js';

class FakePiSession implements PiSession {
  readonly sessionId = 'node-test-session';
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'test', id: 'fake' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  private listeners: Array<
    (event: { type: 'agent_start' | 'agent_end'; messages?: never[]; willRetry?: boolean }) => void
  > = [];

  getActiveToolNames(): string[] {
    return ['read', 'bash', 'edit', 'write'];
  }
  subscribe(listener: (event: never) => void): () => void {
    this.listeners.push(listener as never);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }
  async prompt(): Promise<void> {
    this.listeners.forEach((listener) => listener({ type: 'agent_start' }));
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  async setModel(model: { provider: string; id: string }): Promise<void> {
    this.model = model;
  }
  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }
  setActiveToolsByName(): void {}
  async compact(): Promise<void> {}
  async navigateTree(): Promise<void> {}
  async reload(): Promise<void> {}
  dispose(): void {}
}

class FakePiSessionFactory implements PiSessionFactory {
  readonly session = new FakePiSession();
  async create(): Promise<PiSession> {
    return this.session;
  }
}

describe('Fastify application', () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('exposes the frontend-compatible health endpoint', async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('serves the built frontend and falls back to index.html for SPA routes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-web-dist-'));
    try {
      await mkdir(join(dir, 'assets'), { recursive: true });
      await writeFile(join(dir, 'index.html'), '<!doctype html><title>pi test ui</title>', 'utf8');
      await writeFile(join(dir, 'assets', 'app.js'), 'console.log("app")', 'utf8');

      const app = createApp({ webDistDir: dir });
      apps.push(app);

      const home = await app.inject({ method: 'GET', url: '/' });
      expect(home.statusCode).toBe(200);
      expect(home.headers['content-type']).toContain('text/html');
      expect(home.body).toContain('pi test ui');

      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toBe('console.log("app")');

      // SPA 客户端路由：未匹配到文件的 GET 回退到 index.html
      const spa = await app.inject({ method: 'GET', url: '/some/client/route' });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain('pi test ui');

      // /api 不受静态托管影响：显式路由正常，未命中路径返回 404 JSON 而非 index.html
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);

      const missing = await app.inject({ method: 'GET', url: '/api/nonexistent' });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).not.toContain('pi test ui');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('logs incoming requests when a logger is enabled', async () => {
    const lines: string[] = [];
    const app = createApp({
      logger: { level: 'info', stream: { write: (msg: string) => lines.push(msg) } },
    });
    apps.push(app);

    await app.inject({ method: 'GET', url: '/api/health' });

    expect(lines.some((line) => line.includes('"/api/health"'))).toBe(true);
  });

  it('creates an original-Pi-compatible agent session', async () => {
    const registry = new AgentRegistry(new FakePiSessionFactory());
    const app = createApp({ registry });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: process.cwd(), message: 'hello' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ success: true, sessionId: 'node-test-session' });
    expect(registry.state('node-test-session')).toMatchObject({ isStreaming: false });

    const [sessions, detail] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/sessions' }),
      app.inject({ method: 'GET', url: '/api/sessions/node-test-session' }),
    ]);
    expect(sessions.json()).toMatchObject({
      sessions: [{ id: 'node-test-session', cwd: process.cwd() }],
    });
    expect(detail.json()).toMatchObject({
      sessionId: 'node-test-session',
      context: { thinkingLevel: 'medium', model: { provider: 'test', modelId: 'fake' } },
    });

    const modelChange = await app.inject({
      method: 'POST',
      url: '/api/agent/node-test-session',
      payload: { type: 'set_model', provider: 'next', modelId: 'model' },
    });
    expect(modelChange.statusCode).toBe(200);
    expect(registry.state('node-test-session')).toMatchObject({
      model: { provider: 'next', modelId: 'model' },
    });
  });

  it('exposes the session Plan view through the agent API', async () => {
    // 用桩替换 PlanModeService：本测试只验证 HTTP 路由把计划视图透传出去，
    // 状态机与工具的完整行为在 plan-mode.test.ts / plan-tools.test.ts 覆盖。
    const plans = {
      state: () => ({
        planId: 'task-1',
        taskId: 'task-1',
        sessionId: 'node-test-session',
        status: 'proposed' as const,
        revision: 3,
        title: '重构 Plan 模式',
        goal: '把正则换成工具契约',
        steps: [{ id: 's1', title: 'Inspect the API', status: 'pending' as const }],
        awaitingUserAction: true,
        updatedAt: '2026-08-21T10:00:00.000Z',
      }),
      // AgentRegistry 构造时会给 plans 挂 setListener（SSE 转发），桩里保持无操作。
      setListener: () => undefined,
    };
    const registry = new AgentRegistry(
      new FakePiSessionFactory(),
      undefined,
      plans as unknown as PlanModeService,
    );
    const app = createApp({ registry });
    apps.push(app);
    await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: process.cwd(), message: 'hello' },
    });

    const response = await app.inject({ method: 'GET', url: '/api/agent/node-test-session/plan' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plan: {
        planId: 'task-1',
        status: 'proposed',
        awaitingUserAction: true,
        steps: [{ id: 's1', title: 'Inspect the API' }],
      },
    });
  });

  it('serves preset CRUD and protects the built-in preset', async () => {
    const presetDir = await mkdtemp(join(tmpdir(), 'pi-node-presets-'));
    try {
      const app = createApp({ presetService: new PresetService(presetDir) });
      apps.push(app);

      const list = await app.inject({ method: 'GET', url: '/api/presets' });
      expect(list.statusCode).toBe(200);
      expect(list.json().presets[0]).toMatchObject({ id: 'coding-agent', builtin: true });

      const created = await app.inject({
        method: 'POST',
        url: '/api/presets',
        payload: {
          name: '测试',
          systemPrompt: 'You are helpful.',
          toolNames: ['read'],
          compaction: { enabled: true, keepRecentTokens: 8000, reserveTokens: 16384 },
          provider: '',
          modelId: '',
          thinkingLevel: '',
        },
      });
      expect(created.statusCode).toBe(200);
      const id = created.json().preset.id as string;

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/presets/${id}`,
        payload: {
          name: '测试改',
          systemPrompt: '',
          toolNames: [],
          compaction: { enabled: false, keepRecentTokens: 8000, reserveTokens: 16384 },
          provider: '',
          modelId: '',
          thinkingLevel: 'off',
        },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().preset).toMatchObject({ id, name: '测试改', thinkingLevel: 'off' });

      const builtinDelete = await app.inject({
        method: 'DELETE',
        url: '/api/presets/coding-agent',
      });
      expect(builtinDelete.statusCode).toBe(400);
      expect(builtinDelete.json()).toMatchObject({ error: { code: 'builtin_preset' } });

      const deleted = await app.inject({ method: 'DELETE', url: `/api/presets/${id}` });
      expect(deleted.statusCode).toBe(200);
    } finally {
      await rm(presetDir, { recursive: true, force: true });
    }
  });

  it('validates systemPrompt and compaction on agent creation', async () => {
    const app = createApp({ registry: new AgentRegistry(new FakePiSessionFactory()) });
    apps.push(app);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: {
        cwd: process.cwd(),
        message: 'hello',
        compaction: { enabled: 'yes', keepRecentTokens: 8000, reserveTokens: 16384 },
      },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: { code: 'validation_error' } });

    const ok = await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: {
        cwd: process.cwd(),
        message: 'hello',
        systemPrompt: 'custom prompt',
        compaction: { enabled: false, keepRecentTokens: 8000, reserveTokens: 16384 },
      },
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ success: true, sessionId: 'node-test-session' });
  });
});

describe('client error contract', () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('maps malformed JSON bodies to 400 invalid_request instead of 500', async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { 'content-type': 'application/json' },
      payload: '{"title": ',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    // 不泄露请求体片段。
    expect(response.body).not.toContain('title');
  });

  it('keeps business errors untouched', async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: '', goal: 'g' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
  });
});

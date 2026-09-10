import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../../src/app.js';
import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';
import { SessionLedger } from '../../src/services/observability/session-ledger.js';
import { openPlatformStore, type PlatformStore } from '../../src/services/platform/store.js';
import type { StreamEvent } from '../../src/services/agent-registry.js';

const stores: PlatformStore[] = [];
const apps: ReturnType<typeof createApp>[] = [];
const tempDirs: string[] = [];

/** 真实存在的临时工作区（/api/agent/new 会校验 cwd 是否为目录）。 */
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-task-route-'));
  tempDirs.push(dir);
  return dir;
}

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
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 最小假会话：够让注册表登记一个活跃会话即可。 */
class FakeSession implements PiSession {
  readonly sessionId = 'session-1';
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'test', id: 'fake' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  private readonly listeners = new Set<(event: unknown) => void>();

  getActiveToolNames(): string[] {
    return ['bash'];
  }
  subscribe(listener: (event: never) => void): () => void {
    this.listeners.add(listener as (event: unknown) => void);
    return () => this.listeners.delete(listener as (event: unknown) => void);
  }
  async prompt(): Promise<void> {
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });
    this.emit({ type: 'agent_settled' });
  }
  emit(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  setThinkingLevel(): void {}
  setActiveToolsByName(): void {}
  async compact(): Promise<void> {}
  async navigateTree(): Promise<void> {}
  async reload(): Promise<void> {}
  dispose(): void {}
}

const factory: PiSessionFactory = { create: async () => new FakeSession() };

describe('task REST routes', () => {
  it('creates, reads, lists and updates tasks with optimistic concurrency', async () => {
    const app = createApp({ store: memoryStore() });
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: '重构 Plan 模式',
        goal: '把正则解析换成结构化工具契约',
        cwd: '/workspace',
        steps: [{ title: '读现有实现' }, { title: '设计工具契约' }],
      },
    });
    expect(created.statusCode).toBe(200);
    const task = created.json().task;
    expect(task).toMatchObject({
      title: '重构 Plan 模式',
      status: 'pending',
      revision: 1,
      origin: 'user',
      cwd: '/workspace',
    });
    expect(task.steps.map((step: { id: string }) => step.id)).toEqual(['s1', 's2']);

    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` });
    expect(detail.json().task.id).toBe(task.id);

    const list = await app.inject({ method: 'GET', url: '/api/tasks?cwd=/workspace' });
    expect(list.json().tasks).toHaveLength(1);
    expect(list.json().tasks[0].id).toBe(task.id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { title: '新标题', ifRevision: 1 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().task).toMatchObject({ title: '新标题', revision: 2 });

    const conflict = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { title: '过期写入', ifRevision: 1 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: {
        code: 'task_conflict',
        details: { expectedRevision: 1, currentRevision: 2 },
      },
    });

    const missingRevision = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { title: 'x' },
    });
    expect(missingRevision.statusCode).toBe(422);
  });

  it('manages steps through their own endpoints', async () => {
    const app = createApp({ store: memoryStore() });
    apps.push(app);

    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 't', goal: 'g', steps: [{ title: 'a' }] },
      })
    ).json().task;

    const added = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/steps`,
      payload: {
        title: '跑构建',
        details: 'npm run build',
        verification: { kind: 'command', command: 'npm run build', expectExitCode: 0 },
        ifRevision: 1,
      },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().task.steps.map((step: { id: string }) => step.id)).toEqual(['s1', 's2']);
    expect(added.json().task.steps[1].verification).toMatchObject({ kind: 'command' });

    const completed = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/steps/s1`,
      payload: {
        status: 'completed',
        evidence: { summary: '读完', toolCallIds: ['call-1'], filesTouched: [] },
        ifRevision: added.json().task.revision,
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().task.status).toBe('in_progress');
    expect(completed.json().task.steps[0]).toMatchObject({
      status: 'completed',
      evidence: { summary: '读完' },
    });

    // 删除未完成的步骤不需要 force。
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}/steps/s2?force=false`,
      payload: { ifRevision: completed.json().task.revision },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().task.steps.map((step: { id: string }) => step.id)).toEqual(['s1']);

    // 已完成的步骤需要 force=true。
    const guarded = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}/steps/s1`,
      payload: { ifRevision: deleted.json().task.revision },
    });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json()).toMatchObject({ error: { code: 'step_completed' } });

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}/steps/s1?force=true`,
      payload: { ifRevision: deleted.json().task.revision },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().task).toMatchObject({ status: 'pending', steps: [] });
  });

  it('cancels tasks and freezes them afterwards', async () => {
    const app = createApp({ store: memoryStore() });
    apps.push(app);

    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 't', goal: 'g' },
      })
    ).json().task;

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/cancel`,
      payload: { ifRevision: 1, reason: '需求取消' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().task).toMatchObject({ status: 'cancelled', blockedReason: '需求取消' });

    const again = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/cancel`,
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().task.revision).toBe(cancelled.json().task.revision);

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/steps`,
      payload: { title: 'x', ifRevision: cancelled.json().task.revision },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: 'task_cancelled' } });
  });

  it('validates input and reports missing tasks', async () => {
    const app = createApp({ store: memoryStore() });
    apps.push(app);

    const badBody = await app.inject({ method: 'POST', url: '/api/tasks', payload: [] });
    expect(badBody.statusCode).toBe(422);

    const badTitle = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: '', goal: 'g' },
    });
    expect(badTitle.statusCode).toBe(422);

    const badFilter = await app.inject({ method: 'GET', url: '/api/tasks?status=nope' });
    expect(badFilter.statusCode).toBe(422);

    const missing = await app.inject({ method: 'GET', url: '/api/tasks/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'task_not_found' } });

    const missingStep = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/nope/steps/s1',
      payload: { status: 'in_progress', ifRevision: 1 },
    });
    expect(missingStep.statusCode).toBe(404);
  });
});

describe('task events and run linkage', () => {
  it('pushes task_updated to the owning session and links runs to the task', async () => {
    const store = memoryStore();
    const registry = new AgentRegistry(
      factory,
      undefined,
      undefined,
      undefined,
      new SessionLedger(store.traces),
    );
    const app = createApp({ store, registry });
    apps.push(app);

    const cwd = tempWorkspace();
    const session = await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd, message: 'hello' },
    });
    expect(session.statusCode).toBe(202);
    const events: StreamEvent[] = [];
    registry.subscribe('session-1', 0, (event) => events.push(event));

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 't', goal: 'g', sessionId: 'session-1', cwd },
    });
    const task = created.json().task;

    // 任务绑定到会话 → 该会话的 SSE 流收到 task_updated。
    const updates = events.filter((event) => event.payload.type === 'task_updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ type: 'task_updated', task: { id: task.id } });

    // 之后的 run 会带上 task_id（账本在 run 开始时从注册表取）。
    await app.inject({
      method: 'POST',
      url: '/api/agent/session-1',
      payload: { type: 'prompt', message: 'do it' },
    });
    store.flush();
    const runs = store.traces.listRuns({ limit: 10 }).runs;
    // 第一个 run 来自建会话时的首条消息（那时还没有任务），所以不带 task_id；
    // 绑定任务之后开始的 run 才带上——这正是「只影响之后开始的 run」的语义。
    expect(runs).toHaveLength(2);
    const [latest, first] = runs; // listRuns 按开始时间倒序
    expect(latest.taskId).toBe(task.id);
    expect(first.taskId).toBeUndefined();
    await registry.close();
  });

  it('broadcasts session-less tasks to every session in the same workspace', async () => {
    const store = memoryStore();
    const registry = new AgentRegistry(factory);
    const app = createApp({ store, registry });
    apps.push(app);

    const cwd = tempWorkspace();
    const session = await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd, message: 'hello' },
    });
    expect(session.statusCode).toBe(202);
    const events: StreamEvent[] = [];
    registry.subscribe('session-1', 0, (event) => events.push(event));

    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 't', goal: 'g', cwd },
    });
    expect(events.filter((event) => event.payload.type === 'task_updated')).toHaveLength(1);

    // 其它工作区的任务不会打扰这个会话。
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 't2', goal: 'g', cwd: join(cwd, 'other') },
    });
    expect(events.filter((event) => event.payload.type === 'task_updated')).toHaveLength(1);
    await registry.close();
  });
});

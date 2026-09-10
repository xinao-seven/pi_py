import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../../src/app.js';
import { remindRecovery } from '../../src/routes/agent.js';
import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';
import { SessionLedger } from '../../src/services/observability/session-ledger.js';
import { QuestionBroker } from '../../src/services/user-question.js';
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

class FakeSessionFactory implements PiSessionFactory {
  async create(): Promise<PiSession> {
    return new FakeSession();
  }
}

const factory: PiSessionFactory = new FakeSessionFactory();

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

describe('task recovery routes (M3)', () => {
  /** 造一个「第 1 步完成、第 2 步进行中」的任务（＝中断现场）。 */
  async function seedInterrupted(app: ReturnType<typeof createApp>): Promise<{ id: string }> {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          title: '重构 Plan 模式',
          goal: 'g',
          sessionId: 'session-1',
          cwd: tempWorkspace(),
          steps: [{ title: '读实现' }, { title: '写迁移' }],
        },
      })
    ).json().task;
    const first = (
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${created.id}/steps/s1`,
        payload: { status: 'completed', ifRevision: created.revision },
      })
    ).json().task;
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${created.id}/steps/s2`,
      payload: { status: 'in_progress', ifRevision: first.revision },
    });
    return { id: created.id };
  }

  it('lists interrupted tasks and resumes them with 202', async () => {
    const store = memoryStore();
    const registry = new AgentRegistry(new FakeSessionFactory());
    const app = createApp({ store, registry });
    apps.push(app);

    // 会话必须先存在（resume 会 registry.open）。
    const session = await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: tempWorkspace(), message: 'hello' },
    });
    expect(session.statusCode).toBe(202);
    // 手工把任务挂到默认测试会话名上（FakeSession 的 id 是 session-1）。
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 't', goal: 'g', sessionId: 'session-1', steps: [{ title: 'a' }] },
      })
    ).json().task;
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${created.id}/steps/s1`,
      payload: { status: 'in_progress', ifRevision: created.revision },
    });

    const recovery = await app.inject({ method: 'GET', url: '/api/tasks/recovery' });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json().tasks).toHaveLength(1);
    expect(recovery.json().tasks[0]).toMatchObject({
      taskId: created.id,
      sideEffect: 'none',
      action: 'auto_resume',
    });

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${created.id}/resume`,
      payload: { mode: 'continue' },
    });
    expect(resumed.statusCode).toBe(202);
    expect(resumed.json()).toMatchObject({ ok: true, mode: 'continue' });
    expect(resumed.json().task).toMatchObject({ id: created.id, status: 'in_progress' });
    // 租约已写给本进程。
    expect(resumed.json().task.execution.lease).toBeDefined();

    // 参数校验：非法 mode。
    const badMode = await app.inject({
      method: 'POST',
      url: `/api/tasks/${created.id}/resume`,
      payload: { mode: 'nope' },
    });
    expect(badMode.statusCode).toBe(422);
  });

  it('reports 409 when a resume needs explicit confirmation', async () => {
    const store = memoryStore();
    const registry = new AgentRegistry(new FakeSessionFactory());
    const app = createApp({ store, registry });
    apps.push(app);

    await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: tempWorkspace(), message: 'hello' },
    });
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 't', goal: 'g', sessionId: 'session-1', steps: [{ title: 'a' }] },
      })
    ).json().task;
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/steps/s1`,
      payload: { status: 'in_progress', ifRevision: task.revision },
    });
    // 模拟「编辑工具在飞」：写副作用但无法验证。
    const inFlight = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` })).json()
      .task;
    store.tasks.save(
      {
        ...inFlight,
        execution: {
          ...inFlight.execution,
          inFlight: {
            stepId: 's1',
            kind: 'tool',
            toolCallId: 'call-1',
            toolName: 'edit',
            startedAt: new Date().toISOString(),
            sideEffect: 'write',
          },
        },
      },
      inFlight.revision,
    );

    const needsConfirmation = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/resume`,
      payload: { mode: 'continue' },
    });
    expect(needsConfirmation.statusCode).toBe(409);
    expect(needsConfirmation.json()).toMatchObject({ error: { code: 'task_needs_confirmation' } });

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/resume`,
      payload: { mode: 'continue', confirmSideEffect: true },
    });
    expect(confirmed.statusCode).toBe(202);
  });

  it('rejects replan for manual tasks (only plan tasks can be re-planned)', async () => {
    const store = memoryStore();
    const app = createApp({ store });
    apps.push(app);
    const task = (
      await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 't', goal: 'g' } })
    ).json().task;

    const replan = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/resume`,
      payload: { mode: 'replan' },
    });
    expect(replan.statusCode).toBe(409);
    expect(replan.json()).toMatchObject({ error: { code: 'replan_unavailable' } });
  });

  it('pushes task_recovery_required to the first SSE subscriber', async () => {
    const store = memoryStore();
    const registry = new AgentRegistry(new FakeSessionFactory());
    const app = createApp({ store, registry });
    apps.push(app);

    await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: tempWorkspace(), message: 'hello' },
    });
    const task = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { title: 't', goal: 'g', sessionId: 'session-1', steps: [{ title: 'a' }] },
      })
    ).json().task;
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/steps/s1`,
      payload: { status: 'in_progress', ifRevision: task.revision },
    });

    // 模拟 SSE 建连：路由是「先判有没有订阅者 → 发布提醒 → 再 subscribe」，
    // 因此新订阅者会在 subscribe() 的重放阶段收到这条提醒。
    remindRecovery(registry, 'session-1', () => [{ taskId: task.id, action: 'auto_resume' }]);
    const events: StreamEvent[] = [];
    registry.subscribe('session-1', 0, (event) => events.push(event));

    const reminders = events.filter((event) => event.payload.type === 'task_recovery_required');
    expect(reminders).toHaveLength(1);
    expect(reminders[0].payload).toMatchObject({
      type: 'task_recovery_required',
      tasks: [{ taskId: task.id }],
    });

    // 已有订阅者时不再重复推（避免每次重连都提醒一遍）。
    remindRecovery(registry, 'session-1', () => [{ taskId: task.id }]);
    expect(events.filter((event) => event.payload.type === 'task_recovery_required')).toHaveLength(
      1,
    );

    // 空清单不发事件（也不会因为不存在的会话而建条目）。
    const silent = new AgentRegistry(new FakeSessionFactory());
    silent.announceRecovery('session-1', []);
    expect(silent.hasSubscribers('session-1')).toBe(false);
  });
});

describe('plan routes（M4）', () => {
  /**
   * 路由层只验证「命令到服务的搬运」：Plan 状态机与工具的完整行为在
   * plan-mode.test.ts 覆盖（那里能拿到真实的扩展 API 与任务服务），
   * 与 app.test.ts 对 `/plan` 的做法一致——假 session 没有扩展运行时。
   */
  function stubPlans(view: Record<string, unknown>) {
    const calls: Array<{ action: string; message?: string }> = [];
    const stub = {
      calls,
      setListener: () => undefined,
      setTraceSink: () => undefined,
      setTaskService: () => undefined,
      setExecutor: () => undefined,
      // propose_plan（模型提议）需要提问通道：这里只需满足装配，行为在 plan-mode.test.ts 覆盖。
      setQuestionBroker: () => undefined,
      refresh: () => undefined,
      remove: () => undefined,
      dispose: () => undefined,
      startPlanning: (_sessionId: string, message: string) => {
        calls.push({ action: 'start', message });
        return view;
      },
      state: () => view,
      command: async (_sessionId: string, action: string, message?: string) => {
        calls.push({ action, ...(message === undefined ? {} : { message }) });
        return view;
      },
    };
    return stub as unknown as PlanModeService & { calls: typeof calls };
  }

  const PLAN_VIEW = {
    planId: 'task-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    status: 'drafting',
    revision: 1,
    title: '重构 Plan 模式',
    goal: 'G',
    steps: [],
    awaitingUserAction: false,
    updatedAt: '2026-08-21T10:00:00.000Z',
  };

  it('starts planning when a prompt carries mode="plan"', async () => {
    const plans = stubPlans(PLAN_VIEW);
    const app = createApp({
      store: memoryStore(),
      registry: new AgentRegistry(factory, undefined, plans),
      planService: plans,
    });
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: tempWorkspace(), message: '重构 Plan 模式', mode: 'plan' },
    });
    expect(created.statusCode).toBe(202);
    expect(plans.calls).toEqual([{ action: 'start', message: '重构 Plan 模式' }]);

    // 非法 mode 不能被静默当成 direct。
    const bad = await app.inject({
      method: 'POST',
      url: `/api/agent/${created.json().sessionId}`,
      payload: { type: 'prompt', message: 'x', mode: 'nope' },
    });
    expect(bad.statusCode).toBe(422);
    expect(plans.calls).toHaveLength(1);
  });

  it('maps plan commands to service actions and aborts on pause/abandon', async () => {
    const plans = stubPlans(PLAN_VIEW);
    const registry = new AgentRegistry(factory, undefined, plans);
    const app = createApp({ store: memoryStore(), registry, planService: plans });
    apps.push(app);
    const sessionId = (
      await app.inject({
        method: 'POST',
        url: '/api/agent/new',
        payload: { cwd: tempWorkspace(), message: 'hello' },
      })
    ).json().sessionId as string;
    const abort = vi.spyOn(registry.get(sessionId)!.session, 'abort');

    const commands = [
      { type: 'plan_start', message: '重构 Plan 模式', action: 'start' },
      { type: 'plan_execute', action: 'execute' },
      { type: 'plan_refine', message: '把第二步拆开', action: 'refine' },
      { type: 'plan_pause', action: 'pause' },
      { type: 'plan_resume', action: 'resume' },
      { type: 'plan_abandon', action: 'abandon' },
      // 弃用别名：一个版本内继续工作。
      { type: 'plan_enable', message: '旧客户端', action: 'start' },
      { type: 'plan_disable', action: 'abandon' },
    ];
    for (const command of commands) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/agent/${sessionId}`,
        payload: {
          type: command.type,
          ...(command.message === undefined ? {} : { message: command.message }),
        },
      });
      expect(response.statusCode, command.type).toBe(200);
      expect(response.json().data, command.type).toMatchObject({
        plan: { status: 'drafting' },
      });
    }
    expect(plans.calls.map((call) => call.action)).toEqual([
      'start',
      'execute',
      'refine',
      'pause',
      'resume',
      'abandon',
      'start',
      'abandon',
    ]);
    // pause / abandon / plan_disable 都要真的停手（否则模型会继续跑完）。
    expect(abort).toHaveBeenCalledTimes(3);
  });
});

describe('answer_question 路由（M4.1）', () => {
  it('pushes question_pending and settles it with the answer command', async () => {
    const questions = new QuestionBroker();
    const registry = new AgentRegistry(
      factory,
      undefined,
      undefined,
      undefined,
      undefined,
      questions,
    );
    const app = createApp({ store: memoryStore(), registry, questionBroker: questions });
    apps.push(app);
    const sessionId = (
      await app.inject({
        method: 'POST',
        url: '/api/agent/new',
        payload: { cwd: tempWorkspace(), message: 'hello' },
      })
    ).json().sessionId as string;

    // 等提问挂起（工具在真实链路里由模型调用；这里直接走 broker）。
    const asked = questions.ask({
      sessionId,
      toolCallId: 'call-1',
      questions: [{ id: 'q1', question: '继续吗？', options: ['继续', '停'] }],
    });
    const pending = questions.pendingForSession(sessionId)!;
    // 会话状态快照里能看到挂起的问题（刷新页面也能恢复弹窗）。
    expect(registry.state(sessionId)?.pendingQuestion).toMatchObject({
      questionId: pending.questionId,
    });

    const answered = await app.inject({
      method: 'POST',
      url: `/api/agent/${sessionId}`,
      payload: {
        type: 'answer_question',
        questionId: pending.questionId,
        answers: [{ id: 'q1', selected: ['继续'] }],
      },
    });
    expect(answered.statusCode).toBe(200);
    expect((await asked).outcome).toMatchObject({ answered: true, reason: 'user' });
    expect(registry.state(sessionId)?.pendingQuestion).toBeNull();
  });

  it('rejects answers for unknown questions and malformed payloads', async () => {
    const questions = new QuestionBroker();
    const registry = new AgentRegistry(
      factory,
      undefined,
      undefined,
      undefined,
      undefined,
      questions,
    );
    const app = createApp({ store: memoryStore(), registry, questionBroker: questions });
    apps.push(app);
    const sessionId = (
      await app.inject({
        method: 'POST',
        url: '/api/agent/new',
        payload: { cwd: tempWorkspace(), message: 'hello' },
      })
    ).json().sessionId as string;

    const missing = await app.inject({
      method: 'POST',
      url: `/api/agent/${sessionId}`,
      payload: { type: 'answer_question', questionId: 'nope', answers: [] },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'question_not_found' } });

    const badAnswers = await app.inject({
      method: 'POST',
      url: `/api/agent/${sessionId}`,
      payload: { type: 'answer_question', questionId: 'x', answers: 'nope' },
    });
    expect(badAnswers.statusCode).toBe(422);
  });
});

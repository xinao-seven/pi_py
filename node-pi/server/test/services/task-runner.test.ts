import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';
import { openPlatformStore, type PlatformStore } from '../../src/services/platform/store.js';
import { TaskInFlightTracker } from '../../src/services/task-recovery-extension.js';
import { TaskRecoveryService } from '../../src/services/task-recovery.js';
import { TaskRunner } from '../../src/services/task-runner.js';
import { TaskService } from '../../src/services/task-service.js';
import type { TaskRecord } from '../../src/services/platform/task-model.js';

const tempDirs: string[] = [];
const opened: Array<{ close(): void }> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-task-runner-'));
  tempDirs.push(dir);
  return dir;
}

function track<T extends { close(): void }>(value: T): T {
  opened.push(value);
  return value;
}

afterEach(async () => {
  while (opened.length) {
    try {
      opened.pop()!.close();
    } catch {
      // 已关闭：忽略
    }
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 假会话：记录收到的 prompt，并允许测试手动推事件。 */
class FakeSession implements PiSession {
  readonly sessionId = 'session-1';
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'test', id: 'fake' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  readonly prompts: string[] = [];
  private readonly listeners = new Set<(event: unknown) => void>();

  getActiveToolNames(): string[] {
    return ['read', 'edit'];
  }
  subscribe(listener: (event: never) => void): () => void {
    this.listeners.add(listener as (event: unknown) => void);
    return () => this.listeners.delete(listener as (event: unknown) => void);
  }
  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
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

/**
 * 一个「进程」的完整装配：store（可指定库文件以模拟重启）+ registry + 任务服务 + 执行器。
 */
interface Process {
  store: PlatformStore;
  tasks: TaskService;
  registry: AgentRegistry;
  session: FakeSession;
  tracker: TaskInFlightTracker;
  recovery: TaskRecoveryService;
  runner: TaskRunner;
  owner: string;
  advance(ms: number): void;
  nowIso(): string;
}

function startProcess(options: {
  dbPath: string;
  owner?: string;
  clock?: { now: number };
}): Process {
  const clock = options.clock ?? { now: Date.UTC(2026, 7, 21, 10, 0, 0) };
  const now = () => new Date(clock.now);
  const store = track(openPlatformStore({ mode: 'sqlite', dbPath: options.dbPath }));
  let serial = 0;
  const tasks = new TaskService(store.tasks, { idFactory: () => `task-${(serial += 1)}`, now });
  const session = new FakeSession();
  const factory: PiSessionFactory = { create: async () => session };
  const registry = new AgentRegistry(factory);
  const owner = options.owner ?? 'owner-a';
  const recovery = new TaskRecoveryService(tasks, { owner, now: () => clock.now });
  // runner 与 tracker 互相引用（settled → 释放租约），与 app.ts 一样用延迟绑定。
  let runner: TaskRunner | undefined;
  const tracker = new TaskInFlightTracker(tasks, {
    lookupActiveTask: (sessionId) => registry.get(sessionId)?.activeTaskId,
    onSettled: (sessionId) => runner?.handleSettled(sessionId),
    now,
  });
  const abortedChildren: Array<{ parentSessionId: string; reason?: string }> = [];
  runner = new TaskRunner({
    tasks,
    recovery,
    registry,
    tracker,
    owner,
    // M5：任务停手时也要停掉它派出去的子任务
    subagents: {
      abortAll: (parentSessionId, reason) =>
        abortedChildren.push(
          reason === undefined ? { parentSessionId } : { parentSessionId, reason },
        ),
    },
  });
  return {
    store,
    tasks,
    registry,
    session,
    tracker,
    recovery,
    runner,
    owner,
    abortedChildren,
    advance: (ms: number) => (clock.now += ms),
    nowIso: () => new Date(clock.now).toISOString(),
  };
}

/** 造一个「第 1 步完成、第 2 步进行中」的任务（＝中断现场）。 */
function seedInterruptedTask(
  runtime: Process,
  options: {
    sessionId?: string;
    verification?: { kind: 'file'; path: string };
    inFlight?: { toolName: string; sideEffect: 'none' | 'write' | 'unknown' };
  } = {},
): TaskRecord {
  const created = runtime.tasks.create({
    title: '重构 Plan 模式',
    goal: '把正则解析换成结构化工具契约',
    sessionId: options.sessionId ?? 'session-1',
    cwd: process.cwd(),
    steps: [
      { title: '读现有实现' },
      { title: '写迁移', ...(options.verification ? { verification: options.verification } : {}) },
    ],
  });
  const first = runtime.tasks.updateStep(created.id, 's1', {
    status: 'completed',
    evidence: { summary: '读完', toolCallIds: [], filesTouched: [] },
    ifRevision: created.revision,
  });
  const running = runtime.tasks.updateStep(first.id, 's2', {
    status: 'in_progress',
    ifRevision: first.revision,
  });
  if (options.inFlight) {
    runtime.tasks.setInFlight(running.id, {
      stepId: 's2',
      kind: 'tool',
      toolCallId: 'call-1',
      toolName: options.inFlight.toolName,
      startedAt: runtime.nowIso(),
      sideEffect: options.inFlight.sideEffect,
    });
  }
  return running;
}

/** 让 registry 里有一个活跃会话来承载续跑。 */
async function openSession(runtime: Process): Promise<void> {
  await runtime.registry.create({ cwd: process.cwd() });
}

function expectError(action: () => unknown | Promise<unknown>, statusCode: number, code: string) {
  return expect(Promise.resolve().then(action)).rejects.toMatchObject({ statusCode, code });
}

describe('TaskRunner resume', () => {
  it('resumes an interrupted task after a restart, injects context and releases the lease on settle', async () => {
    const dbPath = join(tempDir(), 'platform.db');
    const clock = { now: Date.UTC(2026, 7, 21, 10, 0, 0) };

    // ---- 第一个进程：任务跑到第 2 步时「被杀」（只关库，不释放租约） ----
    const first = startProcess({ dbPath, clock });
    const task = seedInterruptedTask(first, { inFlight: { toolName: 'read', sideEffect: 'none' } });
    first.tasks.setInFlight(task.id, null);
    first.advance(60_000); // 租约过期
    first.store.close();

    // ---- 第二个进程：扫描 → 续跑 ----
    const second = startProcess({ dbPath, clock, owner: 'owner-b' });
    await openSession(second);

    const items = second.recovery.scan();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ taskId: task.id, action: 'auto_resume', step: { id: 's2' } });

    const outcome = await second.runner.resume(task.id, { mode: 'continue' });
    expect(outcome.task.id).toBe(task.id);
    // prompt 已经发给会话（202 语义：不等模型跑完）。
    expect(second.session.prompts).toHaveLength(1);
    expect(second.session.prompts[0]).toContain('继续任务「重构 Plan 模式」');

    // 租约被本进程持有；恢复摘要已登记且只取一次。
    const leased = second.tasks.get(task.id);
    expect(leased.execution.lease?.owner).toBe('owner-b');
    expect(leased.execution.attempt).toBe(2);
    const context = second.tracker.takeResumeContext('session-1');
    expect(context).toContain('[TASK RESUME]');
    expect(context).toContain('已完成步骤');
    expect(context).toContain('当前步骤：[s2] 写迁移');
    expect(second.tracker.takeResumeContext('session-1')).toBeUndefined();

    // run 结束（agent_settled）→ 释放租约、停续期。
    second.tracker.noteSettled('session-1');
    expect(second.runner.activeTaskIds()).toEqual([]);
    expect(second.tasks.get(task.id).execution.lease).toBeUndefined();
  }, 20_000);

  it('refuses to resume a task that another owner is running', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    await openSession(process);
    const task = seedInterruptedTask(process);
    process.tasks.acquireLease(task.id, 'someone-else');

    await expectError(
      () => process.runner.resume(task.id, { mode: 'continue' }),
      409,
      'task_leased',
    );
    expect(process.session.prompts).toHaveLength(0);
  });

  it('blocks the task when an interrupted write has no verifiable artifact (and allows retry_step)', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    await openSession(process);
    const dir = tempDir();
    const artifact = join(dir, 'migration.sql');
    const task = seedInterruptedTask(process, {
      verification: { kind: 'file', path: artifact },
      inFlight: { toolName: 'write', sideEffect: 'write' },
    });
    process.advance(60_000);

    // continue：产物不在 → 标 blocked + 409（绝不当成成功，也不自动重跑）。
    await expectError(
      () => process.runner.resume(task.id, { mode: 'continue' }),
      409,
      'task_artifact_unverified',
    );
    const blocked = process.tasks.get(task.id);
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(blocked.blockedReason).toContain('产物状态需人工确认');
    expect(blocked.execution.lease).toBeUndefined();
    expect(process.session.prompts).toHaveLength(0);

    // retry_step：用户显式要求重做该步骤 → 放行（产物仍不存在也一样）。
    await process.runner.resume(task.id, { mode: 'retry_step' });
    const resumed = process.tasks.get(task.id);
    expect(resumed.steps[1].status).toBe('pending'); // retry_step 会先重置该步骤
    expect(process.session.prompts).toHaveLength(1);
    expect(process.tracker.takeResumeContext('session-1')).toContain('产物未找到');
  }, 20_000);

  it('completes the interrupted step when the declared artifact exists', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    await openSession(process);
    const artifact = join(tempDir(), 'migration.sql');
    writeFileSync(artifact, 'CREATE TABLE t;', 'utf8');
    const task = seedInterruptedTask(process, {
      verification: { kind: 'file', path: artifact },
      inFlight: { toolName: 'write', sideEffect: 'write' },
    });
    process.advance(60_000);

    await process.runner.resume(task.id, { mode: 'continue' });
    const stored = process.tasks.get(task.id);
    // 产物在 → 补记为完成，不重跑；两步都完成 → 任务 completed。
    expect(stored.steps[1]).toMatchObject({ status: 'completed' });
    expect(stored.status).toBe('completed');
    expect(process.session.prompts).toHaveLength(1);
  }, 20_000);

  it('requires explicit confirmation for unknown side effects', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    await openSession(process);
    const task = seedInterruptedTask(process, {
      inFlight: { toolName: 'bash', sideEffect: 'unknown' },
    });
    process.advance(60_000);

    await expectError(
      () => process.runner.resume(task.id, { mode: 'continue' }),
      409,
      'task_needs_confirmation',
    );
    await process.runner.resume(task.id, { mode: 'continue', confirmSideEffect: true });
    expect(process.session.prompts).toHaveLength(1);
    const context = process.tracker.takeResumeContext('session-1');
    expect(context).toContain('副作用处理：用户已确认');
  });

  it('blocks the task when the session file is gone', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    // 故意不创建会话：续跑时 registry.open 会 404。
    const task = seedInterruptedTask(process, { sessionId: 'missing-session' });
    process.advance(60_000);

    await expectError(
      () => process.runner.resume(task.id, { mode: 'continue' }),
      409,
      'task_session_missing',
    );
    const blocked = process.tasks.get(task.id);
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(blocked.blockedReason).toContain('会话文件不存在');
  });

  it('releases leases on graceful shutdown and reports the task as interrupted next time', async () => {
    const dbPath = join(tempDir(), 'platform.db');
    const clock = { now: Date.UTC(2026, 7, 21, 10, 0, 0) };
    const first = startProcess({ dbPath, clock });
    await openSession(first);
    const task = seedInterruptedTask(first);
    first.tasks.setInFlight(task.id, null);
    await first.runner.resume(task.id, { mode: 'continue' });
    expect(first.tasks.get(task.id).execution.lease).toBeDefined();

    // 优雅关闭：释放租约（不留「被占用」的假象），任务仍是 in_progress → 下次启动可恢复。
    first.runner.dispose();
    expect(first.tasks.get(task.id).execution.lease).toBeUndefined();
    first.store.close();

    const second = startProcess({ dbPath, clock, owner: 'owner-b' });
    expect(second.recovery.scan().map((item) => item.taskId)).toEqual([task.id]);
  }, 20_000);
});

describe('TaskRunner dispose', () => {
  it('stops renewing leases of active runs', async () => {
    vi.useFakeTimers();
    try {
      const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
      await openSession(process);
      const task = seedInterruptedTask(process);
      process.tasks.setInFlight(task.id, null);
      await process.runner.resume(task.id, { mode: 'continue' });
      const renewals = vi.spyOn(process.tasks, 'renewLease');

      vi.advanceTimersByTime(11_000);
      expect(renewals).toHaveBeenCalled(); // 续期在跑

      process.runner.dispose();
      renewals.mockClear();
      vi.advanceTimersByTime(30_000);
      expect(renewals).not.toHaveBeenCalled(); // dispose 之后不再续期
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe('TaskRunner.start（M4：计划执行复用同一套租约与绑定）', () => {
  it('acquires a lease, binds the task to the session and sends the prompt', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    await openSession(process);
    const task = process.tasks.create({
      title: '手动任务',
      goal: 'G',
      sessionId: process.session.sessionId,
    });
    const started = await process.runner.start(task.id, '开始执行');
    expect(process.session.prompts).toEqual(['开始执行']);
    expect(process.runner.activeTaskIds()).toEqual([task.id]);
    expect(started.execution.lease?.owner).toBe(process.owner);
    // 绑定生效：此后的工具事件会记到该任务的在飞动作上（M3 的恢复依据）。
    process.tracker.noteToolStart(process.session.sessionId, 'edit', 'call-9', { path: 'a.ts' });
    expect(process.tasks.get(task.id).execution.inFlight).toMatchObject({
      kind: 'tool',
      toolName: 'edit',
      sideEffect: 'write',
    });
    process.tracker.noteToolEnd(process.session.sessionId);

    // 结算后释放租约。
    process.runner.handleSettled(process.session.sessionId);
    expect(process.tasks.get(task.id).execution.lease).toBeUndefined();
  });

  it('refuses a task without a session and never double-starts', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    await openSession(process);
    const orphan = process.tasks.create({ title: 't', goal: 'g' });
    await expect(process.runner.start(orphan.id, 'x')).rejects.toMatchObject({
      code: 'task_session_missing',
    });

    const bound = process.tasks.create({
      title: 't',
      goal: 'g',
      sessionId: process.session.sessionId,
    });
    await process.runner.start(bound.id, 'x');
    // 同进程再启动 = 继续执行（租约是自己的）；别的进程则被租约拦住。
    await process.runner.start(bound.id, 'x');
    const otherProcess = startProcess({
      dbPath: join(tempDir(), 'platform-other.db'),
      owner: 'owner-b',
    });
    otherProcess.tasks.create({ title: 'x', goal: 'g' });
    expect(() => process.tasks.acquireLease(bound.id, 'owner-b')).toThrowError(
      /being executed by owner-a/,
    );
  });

  it('stop() releases the lease without waiting for settle', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    await openSession(process);
    const task = process.tasks.create({
      title: 't',
      goal: 'g',
      sessionId: process.session.sessionId,
    });
    await process.runner.start(task.id, 'x');
    process.runner.stop(task.id);
    expect(process.tasks.get(task.id).execution.lease).toBeUndefined();
    expect(process.runner.activeTaskIds()).toEqual([]);
    // 停手要连子任务一起停：否则「暂停计划」之后子任务还在改工作区
    expect(process.abortedChildren).toEqual([
      { parentSessionId: process.session.sessionId, reason: '任务已停止' },
    ]);
  });
});

describe('TaskRunner.resume replan（M4 的 M3 接线）', () => {
  it('sends a plan back to drafting and asks the model to re-plan', async () => {
    const process = startProcess({ dbPath: join(tempDir(), 'platform.db') });
    await openSession(process);
    const plan = process.tasks.createPlan({
      title: '重构 Plan 模式',
      goal: 'G',
      sessionId: process.session.sessionId,
    });
    process.tasks.replacePlanSteps(plan.id, [{ title: 'a' }, { title: 'b' }]);
    const current = process.tasks.get(plan.id);
    process.tasks.updateStep(plan.id, 's1', {
      status: 'in_progress',
      ifRevision: current.revision,
    });

    const outcome = await process.runner.resume(plan.id, { mode: 'replan' });
    expect(outcome.prompt).toContain('重新规划任务');
    expect(process.tasks.get(plan.id).execution.plan?.status).toBe('drafting');
    // 恢复摘要仍然注入（模型要先复述中断前的状态）。
    expect(process.session.prompts[0]).toContain('重新规划任务');

    // 非计划任务仍然拒绝 replan。
    const manual = process.tasks.create({
      title: 't',
      goal: 'g',
      sessionId: process.session.sessionId,
      steps: [{ title: 'a' }],
    });
    expect(() => process.recovery.describeItem(manual.id)).not.toThrow();
    await expect(process.runner.resume(manual.id, { mode: 'replan' })).rejects.toMatchObject({
      code: 'replan_unavailable',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../src/errors.js';
import { MemoryTaskRepository } from '../../src/services/platform/task-repository.js';
import { TaskService } from '../../src/services/task-service.js';
import type { TaskRecord } from '../../src/services/platform/task-model.js';

/** 可控时钟 + 固定 id 的任务服务。 */
function makeService() {
  let clock = Date.UTC(2026, 7, 21, 10, 0, 0);
  let serial = 0;
  const repository = new MemoryTaskRepository();
  const service = new TaskService(repository, {
    idFactory: () => `task-${(serial += 1)}`,
    now: () => new Date((clock += 1_000)),
  });
  return { service, repository, tick: (ms: number) => (clock += ms) };
}

/** 捕获 ApiError（错误码 + 状态码）。 */
function expectApiError(action: () => unknown, statusCode: number, code: string): void {
  try {
    action();
    throw new Error('expected an ApiError');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error as ApiError).toMatchObject({ statusCode, code });
  }
}

function createTask(service: TaskService, steps?: Array<{ title: string }>): TaskRecord {
  return service.create({
    title: '重构 Plan 模式',
    goal: '把正则解析换成结构化工具契约',
    sessionId: 'session-1',
    cwd: '/workspace',
    ...(steps === undefined ? {} : { steps }),
  });
}

describe('TaskService creation', () => {
  it('creates a task shell and derives status from steps', () => {
    const { service } = makeService();
    const empty = createTask(service);
    expect(empty).toMatchObject({
      id: 'task-1',
      status: 'pending',
      origin: 'user',
      sessionId: 'session-1',
      cwd: '/workspace',
      revision: 1,
      execution: { attempt: 1 },
      steps: [],
    });

    const withSteps = createTask(service, [{ title: '第一步' }, { title: '第二步' }]);
    expect(withSteps.steps.map((step) => [step.id, step.position, step.status])).toEqual([
      ['s1', 0, 'pending'],
      ['s2', 1, 'pending'],
    ]);
    expect(withSteps.status).toBe('pending');
  });

  it('accepts optional step details and verification declarations', () => {
    const { service } = makeService();
    const task = service.create({
      title: 't',
      goal: 'g',
      steps: [
        {
          title: '跑构建',
          details: 'npm run build',
          verification: { kind: 'command', command: 'npm run build', expectExitCode: 0 },
        },
      ],
    });
    expect(task.steps[0]).toMatchObject({
      id: 's1',
      details: 'npm run build',
      verification: { kind: 'command', command: 'npm run build', expectExitCode: 0 },
    });
  });

  it('validates input', () => {
    const { service } = makeService();
    expectApiError(() => service.create({ title: '  ', goal: 'g' }), 422, 'validation_error');
    expectApiError(() => service.create({ title: 't', goal: '' }), 422, 'validation_error');
    expectApiError(
      () => service.create({ title: 't', goal: 'g', steps: [{ title: '' }] }),
      422,
      'validation_error',
    );
    expectApiError(
      () => service.create({ title: 't', goal: 'g', steps: [{ title: 'a', id: 'x1' }] }),
      422,
      'validation_error',
    );
    expectApiError(
      () =>
        service.create({
          title: 't',
          goal: 'g',
          steps: [
            { title: 'a', id: 's1' },
            { title: 'b', id: 's1' },
          ],
        }),
      422,
      'validation_error',
    );
    expectApiError(
      () =>
        service.create({
          title: 't',
          goal: 'g',
          steps: [{ title: 'a', verification: { kind: 'command' } as never }],
        }),
      422,
      'validation_error',
    );
    expectApiError(
      () => service.create({ title: 'x'.repeat(201), goal: 'g' }),
      422,
      'validation_error',
    );
  });
});

describe('TaskService reads', () => {
  it('404s unknown tasks and validates list filters', () => {
    const { service } = makeService();
    expectApiError(() => service.get('missing'), 404, 'task_not_found');
    expectApiError(() => service.list({ status: 'nope' }), 422, 'validation_error');
    expectApiError(() => service.list({ limit: '0' }), 422, 'validation_error');
    expectApiError(() => service.list({ limit: '1000' }), 422, 'validation_error');
  });

  it('lists newest first and filters by status / session / cwd', () => {
    const { service } = makeService();
    const first = createTask(service);
    const second = service.create({ title: 'b', goal: 'g', cwd: '/other' });
    service.update(second.id, { status: 'in_progress', ifRevision: second.revision });

    expect(service.list().map((task) => task.id)).toEqual([second.id, first.id]);
    expect(service.list({ status: 'in_progress' }).map((task) => task.id)).toEqual([second.id]);
    expect(service.list({ sessionId: 'session-1' }).map((task) => task.id)).toEqual([first.id]);
    expect(service.list({ cwd: '/other' }).map((task) => task.id)).toEqual([second.id]);
    expect(service.list({ limit: '1' }).map((task) => task.id)).toEqual([second.id]);
  });
});

describe('TaskService updates and concurrency', () => {
  it('updates text fields and bumps the revision', () => {
    const { service } = makeService();
    const task = createTask(service);
    const updated = service.update(task.id, {
      title: '新标题',
      conclusion: '已完成',
      ifRevision: task.revision,
    });
    expect(updated).toMatchObject({ title: '新标题', conclusion: '已完成', revision: 2 });
  });

  it('rejects writes with a stale ifRevision and reports the current revision', () => {
    const { service } = makeService();
    const task = createTask(service);
    service.update(task.id, { title: '第一次', ifRevision: 1 });

    try {
      service.update(task.id, { title: '第二次', ifRevision: 1 });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'task_conflict',
        details: { expectedRevision: 1, currentRevision: 2 },
      });
    }
    expect(service.get(task.id)).toMatchObject({ title: '第一次', revision: 2 });
  });

  it('requires ifRevision on every mutation', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }]);
    expectApiError(() => service.update(task.id, { title: 'x' }), 422, 'validation_error');
    expectApiError(() => service.addStep(task.id, { title: 'b' }), 422, 'validation_error');
    expectApiError(
      () => service.updateStep(task.id, 's1', { status: 'in_progress' }),
      422,
      'validation_error',
    );
    expectApiError(() => service.removeStep(task.id, 's1', {}), 422, 'validation_error');
  });

  it('requires a reason for blocked status and clears it when unblocked', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }]);
    expectApiError(
      () => service.update(task.id, { status: 'blocked', ifRevision: 1 }),
      422,
      'validation_error',
    );

    const blocked = service.update(task.id, {
      status: 'blocked',
      blockedReason: '等用户确认',
      ifRevision: 1,
    });
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: '等用户确认' });

    const resumed = service.update(blocked.id, { status: 'in_progress', ifRevision: 2 });
    expect(resumed).toMatchObject({ status: 'in_progress' });
    expect(resumed.blockedReason).toBeUndefined();
  });
});

describe('TaskService steps', () => {
  it('appends steps with fresh ids and re-derives the task status', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }]);
    const added = service.addStep(task.id, { title: 'b', ifRevision: 1 });
    expect(added.steps.map((step) => step.id)).toEqual(['s1', 's2']);
    expect(added.revision).toBe(2);

    const removed = service.removeStep(task.id, 's1', { ifRevision: 2 });
    const reAdded = service.addStep(task.id, { title: 'c', ifRevision: removed.revision });
    // 删除过的 id 不复用（s2 之后是 s3）。
    expect(reAdded.steps.map((step) => step.id)).toEqual(['s2', 's3']);
  });

  it('maintains startedAt / completedAt across status transitions', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }]);
    const running = service.updateStep(task.id, 's1', { status: 'in_progress', ifRevision: 1 });
    expect(running.steps[0].startedAt).toBeDefined();
    expect(running.steps[0].completedAt).toBeUndefined();

    const done = service.updateStep(task.id, 's1', {
      status: 'completed',
      ifRevision: running.revision,
      evidence: {
        summary: '构建通过',
        toolCallIds: ['call-1'],
        filesTouched: ['dist/index.js'],
        commands: [{ command: 'npm run build', exitCode: 0 }],
      },
    });
    expect(done.steps[0]).toMatchObject({ status: 'completed', evidence: { summary: '构建通过' } });
    expect(done.steps[0].completedAt).toBeDefined();
    expect(done.status).toBe('completed');

    const retried = service.updateStep(task.id, 's1', {
      status: 'in_progress',
      ifRevision: done.revision,
    });
    expect(retried.steps[0].completedAt).toBeUndefined();
  });

  it('recomputes the task status when a step changes', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    const first = service.updateStep(task.id, 's1', { status: 'completed', ifRevision: 1 });
    expect(first.status).toBe('in_progress');

    // 已开工但被阻塞：blocked 优先于 in_progress（需要人介入的状态更该被看到）。
    const blocked = service.updateStep(task.id, 's2', {
      status: 'blocked',
      blockedReason: '缺前置',
      ifRevision: first.revision,
    });
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: '缺前置' });

    // 解除阻塞：从阻塞步骤的原因回到聚合结果。
    const resumed = service.updateStep(task.id, 's2', {
      status: 'in_progress',
      ifRevision: blocked.revision,
    });
    expect(resumed.status).toBe('in_progress');
  });

  it('keeps terminal status sticky when steps change afterwards', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }]);
    const done = service.update(task.id, { status: 'completed', ifRevision: 1 });
    const stepped = service.addStep(done.id, { title: 'b', ifRevision: done.revision });
    expect(stepped.status).toBe('completed');
  });

  it('reorders steps by position', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    const moved = service.updateStep(task.id, 's3', { position: 0, ifRevision: 1 });
    expect(moved.steps.map((step) => [step.id, step.position])).toEqual([
      ['s3', 0],
      ['s1', 1],
      ['s2', 2],
    ]);
  });

  it('guards impossible or unsafe operations', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }]);
    expectApiError(
      () => service.updateStep(task.id, 'missing', { status: 'in_progress', ifRevision: 1 }),
      404,
      'task_step_not_found',
    );
    expectApiError(
      () => service.removeStep(task.id, 'missing', { ifRevision: 1 }),
      404,
      'task_step_not_found',
    );
    expectApiError(
      () => service.updateStep(task.id, 's1', { status: 'blocked', ifRevision: 1 }),
      422,
      'validation_error',
    );

    const done = service.updateStep(task.id, 's1', { status: 'completed', ifRevision: 1 });
    expectApiError(
      () => service.removeStep(task.id, 's1', { ifRevision: done.revision }),
      409,
      'step_completed',
    );
    const forced = service.removeStep(task.id, 's1', {
      ifRevision: done.revision,
      force: true,
    });
    expect(forced.steps).toEqual([]);
  });

  it('re-derives the task status after deleting the unfinished step', () => {
    const { service } = makeService();
    // DoD 场景：删掉唯一未完成的步骤 → 没有剩余步骤 → 回落为 pending。
    const single = createTask(service, [{ title: 'a' }]);
    const running = service.updateStep(single.id, 's1', { status: 'in_progress', ifRevision: 1 });
    expect(running.status).toBe('in_progress');
    expect(service.removeStep(single.id, 's1', { ifRevision: running.revision }).status).toBe(
      'pending',
    );

    // 另一种情形：删掉未完成步骤后只剩已完成的步骤 → 聚合为 completed（不滞留 in_progress）。
    const pair = createTask(service, [{ title: 'a' }, { title: 'b' }]);
    const first = service.updateStep(pair.id, 's1', { status: 'completed', ifRevision: 1 });
    expect(first.status).toBe('in_progress');
    const afterDelete = service.removeStep(pair.id, 's2', { ifRevision: first.revision });
    expect(afterDelete.status).toBe('completed');
  });
});

describe('TaskService cancellation and notification', () => {
  it('cancels idempotently and freezes the task afterwards', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }]);
    const cancelled = service.cancel(task.id, { ifRevision: 1, reason: '需求取消' });
    expect(cancelled).toMatchObject({ status: 'cancelled', blockedReason: '需求取消' });

    expect(service.cancel(task.id)).toEqual(cancelled); // 幂等，不再改版本
    expectApiError(
      () => service.update(cancelled.id, { title: 'x', ifRevision: cancelled.revision }),
      409,
      'task_cancelled',
    );
    expectApiError(
      () => service.addStep(cancelled.id, { title: 'x', ifRevision: cancelled.revision }),
      409,
      'task_cancelled',
    );
    // 陈旧版本号即使目标是终态也要先报冲突（避免悄悄 no-op）。
    expectApiError(() => service.cancel(task.id, { ifRevision: 1 }), 409, 'task_conflict');
    // 不带 ifRevision 的重复取消仍是幂等 no-op。
    expect(service.cancel(task.id)).toEqual(cancelled);
  });

  it('notifies listeners on every successful write with the stored revision', () => {
    const { service } = makeService();
    const seen: Array<{ id: string; revision: number; status: string }> = [];
    service.setListener((task) =>
      seen.push({ id: task.id, revision: task.revision, status: task.status }),
    );

    const task = createTask(service, [{ title: 'a' }]);
    service.updateStep(task.id, 's1', { status: 'completed', ifRevision: 1 });

    expect(seen).toEqual([
      { id: 'task-1', revision: 1, status: 'pending' },
      { id: 'task-1', revision: 2, status: 'completed' },
    ]);
  });

  it('reports the owning session so runs can be linked to the task', () => {
    const { service } = makeService();
    const linked: Array<[string, string | null]> = [];
    service.setSessionTaskListener((sessionId, taskId) => linked.push([sessionId, taskId]));

    const task = createTask(service);
    expect(linked).toEqual([['session-1', 'task-1']]);

    service.attachToSession(task.id, null);
    expect(linked.at(-1)).toEqual(['session-1', 'task-1']); // 解绑只广播一次（null 不广播）
  });

  it('swallows listener failures', () => {
    const { service } = makeService();
    service.setListener(() => {
      throw new Error('sse broken');
    });
    expect(() => createTask(service)).not.toThrow();
  });
});

describe('TaskService refreshStatus', () => {
  it('is a pure aggregation over steps', () => {
    const { service } = makeService();
    const task = createTask(service, [{ title: 'a' }]);
    expect(
      service.refreshStatus({
        ...task,
        status: 'pending',
        steps: [{ ...task.steps[0], status: 'skipped' }],
      }),
    ).toMatchObject({ status: 'completed' });
    expect(service.refreshStatus({ ...task, status: 'cancelled' })).toMatchObject({
      status: 'cancelled',
    });
    expect(service.refreshStatus({ ...task, steps: [] })).toMatchObject({ status: 'pending' });
    const spy = vi.fn();
    service.setListener(spy);
    expect(spy).not.toHaveBeenCalled();
  });
});

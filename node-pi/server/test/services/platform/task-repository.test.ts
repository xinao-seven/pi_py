import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteTraceStorage } from '../../../src/services/platform/sqlite-trace-storage.js';
import {
  MemoryTaskRepository,
  SqliteTaskRepository,
  type TaskRepository,
} from '../../../src/services/platform/task-repository.js';
import {
  emptyExecution,
  newStep,
  type TaskRecord,
} from '../../../src/services/platform/task-model.js';

const tempDirs: string[] = [];
const opened: Array<{ close(): void }> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-task-repo-'));
  tempDirs.push(dir);
  return dir;
}

function track<T extends { close(): void }>(value: T): T {
  opened.push(value);
  return value;
}

const sqliteTaskRepo = (): TaskRepository => {
  const storage = track(SqliteTraceStorage.open(join(tempDir(), 'platform.db')));
  return track(new SqliteTaskRepository(storage.database));
};
const memoryTaskRepo = (): TaskRepository => track(new MemoryTaskRepository());

afterEach(() => {
  while (opened.length) {
    try {
      opened.pop()!.close();
    } catch {
      // 已关闭：忽略
    }
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const NOW = '2026-08-21T10:00:00.000Z';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    title: '重构 Plan 模式',
    goal: '把正则解析换成结构化工具契约',
    status: 'pending',
    steps: [
      newStep({ id: 's1', title: '读现有实现', position: 0 }),
      newStep({ id: 's2', title: '设计工具契约', position: 1 }),
    ],
    origin: 'user',
    sessionId: 'session-1',
    cwd: '/workspace',
    revision: 1,
    execution: emptyExecution(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe.each([
  ['sqlite', sqliteTaskRepo],
  ['memory', memoryTaskRepo],
])('task repository (%s)', (_label, create) => {
  it('inserts, reads and lists tasks with their steps', () => {
    const repository = create();
    repository.insert(task());

    const stored = repository.get('task-1');
    expect(stored).toMatchObject({
      id: 'task-1',
      title: '重构 Plan 模式',
      status: 'pending',
      origin: 'user',
      sessionId: 'session-1',
      cwd: '/workspace',
      revision: 1,
      execution: { attempt: 1 },
    });
    expect(stored?.steps.map((step) => [step.id, step.position, step.status])).toEqual([
      ['s1', 0, 'pending'],
      ['s2', 1, 'pending'],
    ]);
    expect(repository.get('missing')).toBeUndefined();
    expect(repository.list()).toHaveLength(1);
  });

  it('round-trips nested step fields and optional task fields', () => {
    const repository = create();
    repository.insert(
      task({
        blockedReason: '等用户确认',
        conclusion: 'done',
        steps: [
          newStep({
            id: 's1',
            title: '跑构建',
            position: 0,
            details: 'npm run build',
            verification: { kind: 'command', command: 'npm run build', expectExitCode: 0 },
          }),
          {
            ...newStep({ id: 's2', title: '校对输出', position: 1 }),
            status: 'completed',
            startedAt: NOW,
            completedAt: '2026-08-21T10:05:00.000Z',
            evidence: {
              summary: '产物已生成',
              toolCallIds: ['call-1'],
              filesTouched: ['dist/index.js'],
              commands: [{ command: 'npm run build', exitCode: 0 }],
            },
          },
        ],
      }),
    );

    const stored = repository.get('task-1');
    expect(stored?.steps[0].verification).toEqual({
      kind: 'command',
      command: 'npm run build',
      expectExitCode: 0,
    });
    expect(stored?.steps[1]).toMatchObject({
      status: 'completed',
      startedAt: NOW,
      completedAt: '2026-08-21T10:05:00.000Z',
      evidence: { commands: [{ command: 'npm run build', exitCode: 0 }] },
    });
    expect(stored).toMatchObject({ blockedReason: '等用户确认', conclusion: 'done' });
  });

  it('applies optimistic concurrency through save()', () => {
    const repository = create();
    repository.insert(task());

    const stored = repository.get('task-1')!;
    expect(repository.save({ ...stored, title: '改标题' }, 1)).toBe(true);
    expect(repository.get('task-1')).toMatchObject({ title: '改标题', revision: 2 });

    // 过期版本号写入会被拒绝，且不改变库里的内容。
    expect(repository.save({ ...stored, title: '覆盖' }, 1)).toBe(false);
    expect(repository.get('task-1')).toMatchObject({ title: '改标题', revision: 2 });
  });

  it('replaces the whole step list on save (add / delete / reorder)', () => {
    const repository = create();
    repository.insert(task());
    const stored = repository.get('task-1')!;

    const steps = [
      { ...stored.steps[1], position: 0 },
      newStep({ id: 's3', title: '新增步骤', position: 1 }),
    ];
    expect(repository.save({ ...stored, steps, updatedAt: '2026-08-21T11:00:00.000Z' }, 1)).toBe(
      true,
    );

    expect(repository.get('task-1')?.steps.map((step) => step.id)).toEqual(['s2', 's3']);
  });

  it('filters by status, session and cwd, newest first', () => {
    const repository = create();
    repository.insert(task({ id: 'a', status: 'blocked', updatedAt: '2026-08-21T09:00:00.000Z' }));
    repository.insert(
      task({ id: 'b', status: 'in_progress', updatedAt: '2026-08-21T12:00:00.000Z' }),
    );
    repository.insert(
      task({
        id: 'c',
        status: 'completed',
        sessionId: 'session-2',
        cwd: '/other',
        updatedAt: '2026-08-21T11:00:00.000Z',
      }),
    );

    expect(repository.list().map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(repository.list({ status: 'blocked' }).map((item) => item.id)).toEqual(['a']);
    expect(repository.list({ sessionId: 'session-2' }).map((item) => item.id)).toEqual(['c']);
    expect(repository.list({ cwd: '/workspace' }).map((item) => item.id)).toEqual(['b', 'a']);
    expect(repository.list({ limit: 2 }).map((item) => item.id)).toEqual(['b', 'c']);
    expect(repository.list({ status: 'cancelled' })).toEqual([]);
  });

  it('removes tasks with their steps', () => {
    const repository = create();
    repository.insert(task());
    expect(repository.remove('task-1')).toBe(true);
    expect(repository.get('task-1')).toBeUndefined();
    expect(repository.list()).toEqual([]);
    expect(repository.remove('task-1')).toBe(false);
  });
});

describe('task repository parity', () => {
  it('returns identical records for the same writes', () => {
    const sqlite = sqliteTaskRepo();
    const memory = memoryTaskRepo();
    for (const repository of [sqlite, memory]) {
      repository.insert(task());
      const stored = repository.get('task-1')!;
      repository.save(
        {
          ...stored,
          status: 'blocked',
          blockedReason: '等确认',
          steps: [
            { ...stored.steps[0], status: 'completed', startedAt: NOW, completedAt: NOW },
            { ...stored.steps[1], status: 'blocked', blockedReason: '缺前置' },
          ],
          updatedAt: '2026-08-21T12:00:00.000Z',
        },
        1,
      );
    }
    expect(sqlite.get('task-1')).toEqual(memory.get('task-1'));
    expect(sqlite.list()).toEqual(memory.list());
  });
});

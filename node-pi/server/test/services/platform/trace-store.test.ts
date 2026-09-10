import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MemoryTraceStorage } from '../../../src/services/platform/memory-trace-storage.js';
import { SqliteTraceStorage } from '../../../src/services/platform/sqlite-trace-storage.js';
import {
  applyMigrations,
  currentSchemaVersion,
  MIGRATIONS,
  TARGET_SCHEMA_VERSION,
} from '../../../src/services/platform/migrations.js';
import { openPlatformStore } from '../../../src/services/platform/store.js';
import { QueuedTraceRepository } from '../../../src/services/platform/trace-repository.js';
import type {
  RunFinish,
  RunRow,
  StepRow,
  TraceOp,
} from '../../../src/services/platform/trace-model.js';

const DAY = Date.UTC(2026, 7, 20, 10, 0, 0); // 2026-08-20T10:00:00Z

const tempDirs: string[] = [];
/** 所有创建过的后端/存储，afterEach 统一关闭（Windows 下不关文件就会 EPERM）。 */
const opened: Array<{ close(): void }> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-platform-store-'));
  tempDirs.push(dir);
  return dir;
}

function track<T extends { close(): void }>(storage: T): T {
  opened.push(storage);
  return storage;
}

const sqliteStorage = () => track(SqliteTraceStorage.open(join(tempDir(), 'platform.db')));
const memoryStorage = () => track(new MemoryTraceStorage());

afterEach(() => {
  while (opened.length) {
    try {
      opened.pop()!.close();
    } catch {
      // 关闭失败（已关闭/桩后端）忽略，避免掩盖真正的断言失败。
    }
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    cwd: '/workspace',
    provider: 'deepseek',
    model: 'deepseek-chat',
    thinkingLevel: 'medium',
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

function makeFinish(overrides: Partial<RunFinish> = {}): RunFinish {
  return {
    endedAt: DAY + 5_000,
    status: 'completed',
    turns: 2,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    costUsd: 0.012,
    ttftMs: 320,
    durationMs: 5_000,
    stopReason: 'endTurn',
    ...overrides,
  };
}

function makeStep(overrides: Partial<StepRow> = {}): StepRow {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnIndex: 0,
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

/** 一份标准操作序列：2 个 run（1 成功 1 报错）+ 工具/审批/压缩步骤。 */
function sampleOps(): TraceOp[] {
  return [
    { op: 'run_start', run: makeRun() },
    {
      op: 'step',
      step: makeStep({
        toolCallId: 'call-1',
        startedAt: DAY + 100,
        durationMs: 100,
        argsBytes: 20,
        argsDigest: 'aaa',
      }),
    },
    {
      op: 'step',
      step: makeStep({
        toolCallId: 'call-2',
        toolName: 'edit',
        startedAt: DAY + 110,
        durationMs: 300,
        isError: true,
        resultDigest: 'bbb',
        resultBytes: 40,
      }),
    },
    {
      // 被审批拦下的 tool_call：isError=true 但 blocked_by 非空 → 不计入工具失败。
      op: 'step',
      step: makeStep({
        toolCallId: 'call-3',
        startedAt: DAY + 120,
        durationMs: 0,
        isError: true,
        blockedBy: 'approval',
      }),
    },
    {
      op: 'step',
      step: makeStep({
        kind: 'approval',
        toolName: undefined,
        toolCallId: 'call-4',
        startedAt: DAY + 200,
        durationMs: 900,
        isError: false,
        approvalRule: 'recursive-delete',
        approvalRisk: 'critical',
        approvalDecision: 'approved',
        approvalWaitMs: 900,
        decidedBy: 'user',
      }),
    },
    {
      op: 'step',
      step: makeStep({
        kind: 'approval',
        toolName: undefined,
        toolCallId: 'call-5',
        startedAt: DAY + 300,
        durationMs: 1_500,
        isError: true,
        approvalRule: 'recursive-delete',
        approvalRisk: 'critical',
        approvalDecision: 'denied',
        approvalWaitMs: 1_500,
        decidedBy: 'timeout',
      }),
    },
    {
      op: 'step',
      step: makeStep({
        kind: 'llm_call',
        toolName: undefined,
        toolCallId: undefined,
        startedAt: DAY + 400,
        durationMs: 2_000,
      }),
    },
    { op: 'run_finish', runId: 'run-1', patch: makeFinish() },
    {
      op: 'run_start',
      run: makeRun({ id: 'run-2', model: 'deepseek-reasoner', startedAt: DAY + 60_000 }),
    },
    {
      op: 'run_finish',
      runId: 'run-2',
      patch: makeFinish({
        status: 'error',
        turns: 1,
        inputTokens: 500,
        outputTokens: 50,
        costUsd: 0.003,
        durationMs: 9_000,
        ttftMs: 800,
        errorType: 'provider_error',
        errorMessage: 'rate limited',
      }),
    },
  ];
}

function applyTo<T extends { apply(ops: readonly TraceOp[]): void }>(
  storage: T,
  ops: readonly TraceOp[],
): T {
  storage.apply(ops);
  return storage;
}

describe('platform migrations', () => {
  it('creates the schema once and is idempotent', () => {
    const dbPath = join(tempDir(), 'platform.db');
    const db = new DatabaseSync(dbPath);
    // 应用全部待应用迁移（数量随版本增加，断言目标是版本而非固定数字）。
    expect(applyMigrations(db)).toBe(TARGET_SCHEMA_VERSION);
    expect(currentSchemaVersion(db)).toBe(TARGET_SCHEMA_VERSION);
    // 重复迁移不应报错，也不应重复应用（模拟服务重启）。
    expect(applyMigrations(db)).toBe(0);
    db.close();

    const storage = SqliteTraceStorage.open(dbPath);
    expect(storage.schemaVersion).toBe(TARGET_SCHEMA_VERSION);
    storage.close();
  });

  it('repairs a database created by the interim day_rollups schema', () => {
    // 构造「已经跑过旧版代码」的库：建到 v1 后再把它降级回过渡期形态
    // （只有 day_rollups，没有 run_rollups，user_version 仍为 1）。
    const dbPath = join(tempDir(), 'legacy.db');
    const db = new DatabaseSync(dbPath);
    applyMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version === 1),
    );
    db.exec('DROP TABLE run_rollups');
    db.exec(
      'CREATE TABLE day_rollups (day TEXT NOT NULL, cwd TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, cwd))',
    );
    db.exec('PRAGMA user_version = 1');

    expect(applyMigrations(db)).toBe(TARGET_SCHEMA_VERSION - 1); // 只应用 v1 之后的修复迁移
    expect(currentSchemaVersion(db)).toBe(TARGET_SCHEMA_VERSION);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain('run_rollups');
    expect(tables).not.toContain('day_rollups');
    db.close();

    // 修复后聚合读写正常。
    const storage = SqliteTraceStorage.open(dbPath);
    storage.apply([{ op: 'run_start', run: makeRun() }]);
    storage.apply([{ op: 'run_finish', runId: 'run-1', patch: makeFinish() }]);
    expect(storage.summary({}).totals.runs).toBe(1);
    storage.close();
  });

  it('declares a monotonic migration list', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(versions.at(-1)).toBe(TARGET_SCHEMA_VERSION);
  });
});

describe.each([
  ['sqlite', sqliteStorage],
  ['memory', memoryStorage],
])('trace storage (%s)', (_label, create) => {
  it('aggregates runs, tools and approvals; blocked calls are not tool errors', () => {
    const storage = applyTo(create(), sampleOps());
    const summary = storage.summary({ from: DAY - 1, to: DAY + 86_400_000 });

    expect(summary.totals.runs).toBe(2);
    expect(summary.totals.errorRuns).toBe(1);
    expect(summary.totals.turns).toBe(3);
    expect(summary.totals.inputTokens).toBe(1_500);
    expect(summary.totals.outputTokens).toBe(250);
    expect(summary.totals.cacheReadTokens).toBe(100);
    expect(summary.totals.costUsd).toBeCloseTo(0.015, 6);
    expect(summary.totals.durationSamples).toEqual([9_000, 5_000]);
    expect(summary.totals.ttftSamples).toEqual([800, 320]);

    // bash: 2 次调用（1 次正常 + 1 次被审批拦下）。被拦下不算 error。
    const bash = summary.byTool.find((tool) => tool.toolName === 'bash');
    expect(bash).toMatchObject({ calls: 2, errors: 0, blocked: 1, durationMsSum: 100 });
    expect(bash?.durationSamples).toEqual([0, 100]);
    const edit = summary.byTool.find((tool) => tool.toolName === 'edit');
    expect(edit).toMatchObject({ calls: 1, errors: 1, blocked: 0 });

    const approval = summary.byApproval.find((item) => item.rule === 'recursive-delete');
    expect(approval).toMatchObject({
      risk: 'critical',
      approved: 1,
      denied: 1,
      timedOut: 0,
      waitMsSum: 2_400,
      waitSamples: [1_500, 900],
    });

    expect(summary.daily).toEqual([
      { date: '2026-08-20', runs: 2, costUsd: 0.015, inputTokens: 1_500, outputTokens: 250 },
    ]);

    const model = summary.byModel.find((item) => item.model === 'deepseek-chat');
    expect(model).toMatchObject({ provider: 'deepseek', runs: 1, tokens: 1_200 });
    expect(model?.durationSamples).toEqual([5_000]);
    storage.close();
  });

  it('filters by cwd, time window and session', () => {
    const storage = applyTo(create(), [
      { op: 'run_start', run: makeRun({ id: 'a', cwd: '/one' }) },
      { op: 'run_finish', runId: 'a', patch: makeFinish() },
      {
        op: 'run_start',
        run: makeRun({ id: 'b', cwd: '/two', sessionId: 'session-2', startedAt: DAY + 86_400_000 }),
      },
      { op: 'run_finish', runId: 'b', patch: makeFinish() },
    ] satisfies TraceOp[]);

    expect(storage.summary({ cwd: '/one' }).totals.runs).toBe(1);
    expect(storage.summary({ from: DAY, to: DAY + 3_600_000 }).totals.runs).toBe(1);
    expect(storage.summary({}).daily.map((day) => day.date)).toEqual(['2026-08-20', '2026-08-21']);
    expect(
      storage.listRuns({ sessionId: 'session-2', limit: 10 }).runs.map((run) => run.id),
    ).toEqual(['b']);
    storage.close();
  });

  it('paginates runs with a keyset cursor', () => {
    const ops: TraceOp[] = [];
    for (let index = 0; index < 5; index += 1) {
      ops.push({
        op: 'run_start',
        run: makeRun({ id: `run-${index}`, startedAt: DAY + index * 1_000 }),
      });
      ops.push({ op: 'run_finish', runId: `run-${index}`, patch: makeFinish() });
    }
    const storage = applyTo(create(), ops);

    const first = storage.listRuns({ limit: 2 });
    expect(first.runs.map((run) => run.id)).toEqual(['run-4', 'run-3']);
    // 游标指向本页最后一条：下一页严格从它之后继续（键集分页）。
    expect(first.nextCursor).toBe(`${DAY + 3_000}:run-3`);

    const second = storage.listRuns({ limit: 2, cursor: first.nextCursor });
    expect(second.runs.map((run) => run.id)).toEqual(['run-2', 'run-1']);

    const third = storage.listRuns({ limit: 2, cursor: second.nextCursor });
    expect(third.runs.map((run) => run.id)).toEqual(['run-0']);
    expect(third.nextCursor).toBeUndefined();
    storage.close();
  });

  it('returns run detail with steps and child runs', () => {
    const storage = applyTo(create(), [
      { op: 'run_start', run: makeRun() },
      { op: 'step', step: makeStep({ toolCallId: 'call-1' }) },
      { op: 'run_finish', runId: 'run-1', patch: makeFinish() },
      { op: 'run_start', run: makeRun({ id: 'child', parentRunId: 'run-1', taskId: 'task-7' }) },
    ] satisfies TraceOp[]);

    const detail = storage.getRun('run-1');
    expect(detail?.run.id).toBe('run-1');
    expect(detail?.steps).toHaveLength(1);
    expect(detail?.steps[0]).toMatchObject({ toolName: 'bash', isError: false });
    expect(detail?.children.map((run) => run.id)).toEqual(['child']);
    expect(detail?.children[0].taskId).toBe('task-7');
    expect(storage.getRun('missing')).toBeUndefined();
    storage.close();
  });

  it('keeps run-start meta when the run is finished without meta', () => {
    // 回归（M5 实际踩到）：子会话的 preset/depth 在 run 开始时写进 meta，
    // 收尾语句若无条件写 meta，就会把它抹成 NULL——执行树随即看不出「谁派出来的」。
    const sqlite = applyTo(sqliteStorage(), [
      {
        op: 'run_start',
        run: makeRun({ meta: { parentSessionId: 'parent', preset: 'scout', depth: 1 } }),
      },
      { op: 'run_finish', runId: 'run-1', patch: makeFinish() },
    ] satisfies TraceOp[]);
    expect(sqlite.getRun('run-1')?.run.meta).toEqual({
      parentSessionId: 'parent',
      preset: 'scout',
      depth: 1,
    });
    sqlite.close();

    // 内存后端行为必须一致
    const memory = applyTo(memoryStorage(), [
      {
        op: 'run_start',
        run: makeRun({ meta: { parentSessionId: 'parent', preset: 'scout', depth: 1 } }),
      },
      { op: 'run_finish', runId: 'run-1', patch: makeFinish({ meta: { retries: 1 } }) },
    ] satisfies TraceOp[]);
    // 收尾明确给出 meta 时以收尾为准（合并由账本负责）
    expect(memory.getRun('run-1')?.run.meta).toEqual({ retries: 1 });
    memory.close();
  });

  it('keeps rollups when details are pruned', () => {
    const storage = applyTo(create(), sampleOps());
    const deleted = storage.prune(DAY + 30_000); // 删掉 run-1 的明细

    expect(deleted).toBe(1);
    expect(storage.getRun('run-1')).toBeUndefined();
    // 聚合历史保留（预聚合表不随明细清理）。
    expect(storage.summary({}).byTool.find((tool) => tool.toolName === 'bash')?.calls).toBe(2);
    storage.close();
  });
});

describe('sqlite and memory parity', () => {
  it('produces identical summaries for the same ops', () => {
    const sqlite = applyTo(sqliteStorage(), sampleOps());
    const memory = applyTo(memoryStorage(), sampleOps());
    const query = { from: DAY - 1, to: DAY + 86_400_000 };
    expect(sqlite.summary(query)).toEqual(memory.summary(query));
    expect(sqlite.listRuns({ limit: 10 }).runs).toEqual(memory.listRuns({ limit: 10 }).runs);
    expect(sqlite.getRun('run-1')).toEqual(memory.getRun('run-1'));
    sqlite.close();
    memory.close();
  });
});

describe('queued trace repository', () => {
  function makeQueue(storage = memoryStorage(), options = {}) {
    return track(
      new QueuedTraceRepository(
        storage,
        'memory',
        { flushMs: 250, batchSize: 200, maxPending: 5, ...options },
        undefined,
      ),
    );
  }

  it('flushes at the batch size and on read', () => {
    const storage = memoryStorage();
    const repository = makeQueue(storage, { batchSize: 2, maxPending: 100 });
    repository.startRun(makeRun());
    expect(repository.stats().pending).toBe(1);

    repository.finishRun('run-1', makeFinish()); // 到达 batchSize → 立刻 flush
    expect(repository.stats().pending).toBe(0);
    expect(repository.stats().flushed).toBe(2);

    // 读之前强制 flush：刚记录的事件立即可查。
    repository.addStep(makeStep());
    expect(repository.summary({}).byTool).toHaveLength(1);
    expect(repository.stats().pending).toBe(0);
    repository.close();
  });

  it('flushes on the timer', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const repository = makeQueue(storage, { flushMs: 50, maxPending: 100 });
      repository.startRun(makeRun());
      expect(repository.stats().pending).toBe(1);
      vi.advanceTimersByTime(60);
      expect(repository.stats().pending).toBe(0);
      repository.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the oldest ops beyond the queue ceiling', () => {
    const storage = memoryStorage();
    const repository = makeQueue(storage, { maxPending: 3, batchSize: 100 });
    for (let index = 0; index < 5; index += 1) {
      repository.addStep(makeStep({ toolCallId: `call-${index}` }));
    }
    const stats = repository.stats();
    expect(stats.pending).toBe(3);
    expect(stats.dropped).toBe(2);
    repository.close();
  });

  it('degrades instead of throwing when the backend keeps failing', () => {
    const failing = {
      apply: () => {
        throw new Error('disk on fire');
      },
      close: () => undefined,
    } as unknown as MemoryTraceStorage;
    const warnings: string[] = [];
    const repository = new QueuedTraceRepository(
      failing,
      'sqlite',
      { flushMs: 10_000, batchSize: 1, maxPending: 100, maxConsecutiveFailures: 2 },
      {
        debug: () => undefined,
        info: () => undefined,
        warn: (_obj, msg) => warnings.push(msg ?? ''),
        error: () => undefined,
      },
    );

    repository.addStep(makeStep()); // 第 1 次失败
    repository.addStep(makeStep()); // 第 2 次失败 → degraded
    expect(repository.stats().degraded).toBe(true);
    repository.addStep(makeStep()); // 此后直接丢弃，不再撞同一个错误
    expect(repository.stats().dropped).toBe(1);
    expect(repository.stats().failedFlushes).toBe(2);
    expect(warnings.some((line) => line.includes('degraded'))).toBe(true);
    repository.close();
  });

  it('ignores writes after close', () => {
    const repository = makeQueue();
    repository.close();
    repository.startRun(makeRun());
    expect(repository.stats().recorded).toBe(0);
    expect(repository.stats().dropped).toBe(1);
  });
});

describe('platform store assembly', () => {
  it('falls back to memory when the sqlite file cannot be opened', () => {
    const dir = tempDir();
    // 用一个"文件"当目录 → mkdirSync 必然失败。
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x', 'utf8');
    const warnings: string[] = [];
    const store = track(
      openPlatformStore({
        mode: 'sqlite',
        dbPath: join(blocker, 'platform.db'),
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (_obj, msg) => warnings.push(msg ?? ''),
          error: () => undefined,
        },
      }),
    );

    expect(store.mode).toBe('memory');
    expect(warnings.some((line) => line.includes('falling back'))).toBe(true);
    store.traces.startRun(makeRun());
    store.traces.finishRun('run-1', makeFinish());
    expect(store.traces.summary({}).totals.runs).toBe(1);
    store.close();
  });

  it('writes through the queue into the sqlite file', () => {
    const dbPath = join(tempDir(), 'nested', 'platform.db');
    const store = track(openPlatformStore({ mode: 'sqlite', dbPath }));
    expect(store.mode).toBe('sqlite');
    expect(store.schemaVersion).toBe(TARGET_SCHEMA_VERSION);

    store.traces.startRun(makeRun());
    store.traces.addStep(makeStep());
    store.traces.finishRun('run-1', makeFinish());
    store.flush();

    const reopened = track(openPlatformStore({ mode: 'sqlite', dbPath }));
    expect(reopened.traces.summary({}).totals.runs).toBe(1);
    expect(reopened.traces.getRun('run-1')?.steps).toHaveLength(1);
    store.close();
    reopened.close();
  });
});

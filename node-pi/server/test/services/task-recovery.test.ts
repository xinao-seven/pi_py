import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryTaskRepository } from '../../src/services/platform/task-repository.js';
import {
  classifySideEffect,
  TaskRecoveryService,
  type ResumeRequest,
} from '../../src/services/task-recovery.js';
import { TaskService } from '../../src/services/task-service.js';
import { createLeaseOwner } from '../../src/services/task-lease.js';
import type { TaskRecord } from '../../src/services/platform/task-model.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const OWNER = 'test-owner';
/** 与 TaskService 共用一个可控时钟：这样租约过期与步骤时间戳的判断才一致。 */
function makeHarness() {
  let clock = Date.UTC(2026, 7, 21, 10, 0, 0);
  const now = () => new Date(clock);
  const repository = new MemoryTaskRepository();
  let serial = 0;
  const tasks = new TaskService(repository, {
    idFactory: () => `task-${(serial += 1)}`,
    now,
  });
  const recovery = new TaskRecoveryService(tasks, { owner: OWNER, now: () => clock });
  return {
    tasks,
    recovery,
    now,
    advance: (ms: number) => (clock += ms),
    nowMs: () => clock,
  };
}

/** 建一个「第 1 步已完成、第 2 步进行中」的任务（模拟中断现场）。 */
function interruptedTask(
  harness: ReturnType<typeof makeHarness>,
  options: { verification?: { kind: 'file'; path: string } } = {},
): TaskRecord {
  const created = harness.tasks.create({
    title: '重构 Plan 模式',
    goal: '把正则解析换成结构化工具契约',
    sessionId: 'session-1',
    cwd: process.cwd(),
    steps: [
      { title: '读现有实现' },
      { title: '写迁移', ...(options.verification ? { verification: options.verification } : {}) },
    ],
  });
  const first = harness.tasks.updateStep(created.id, 's1', {
    status: 'completed',
    evidence: { summary: '读完', toolCallIds: [], filesTouched: [] },
    ifRevision: created.revision,
  });
  return harness.tasks.updateStep(first.id, 's2', {
    status: 'in_progress',
    ifRevision: first.revision,
  });
}

function expectError(action: () => unknown, statusCode: number, code: string): void {
  try {
    action();
    throw new Error('expected an ApiError');
  } catch (error) {
    expect(error).toMatchObject({ statusCode, code });
  }
}

const resume = (mode: ResumeRequest['mode'], confirmSideEffect?: boolean): ResumeRequest =>
  ({ mode, ...(confirmSideEffect ? { confirmSideEffect: true } : {}) }) as ResumeRequest;

describe('classifySideEffect', () => {
  it('treats read-only tools as safe and write tools as writes', () => {
    expect(classifySideEffect('read', { path: 'a.md' })).toBe('none');
    expect(classifySideEffect('grep', { pattern: 'x' })).toBe('none');
    expect(classifySideEffect('edit', { path: 'a' })).toBe('write');
    expect(classifySideEffect('write', { path: 'a' })).toBe('write');
  });

  it('uses the approval rules for bash and stays conservative otherwise', () => {
    expect(classifySideEffect('bash', { command: 'rm -rf ./build' })).toBe('write');
    expect(classifySideEffect('bash', { command: 'npm run build > log.txt' })).toBe('write');
    // 普通命令也可能是写（python -c open(...)）：不能证明只读 → unknown（宁可多问一次）。
    expect(classifySideEffect('bash', { command: 'ls -la' })).toBe('unknown');
    expect(classifySideEffect('mcp__fs__write_file', {})).toBe('unknown');
  });
});

describe('TaskRecoveryService scan', () => {
  it('lists interrupted tasks only (lease gone), and ignores live leases', () => {
    const harness = makeHarness();
    const task = interruptedTask(harness);

    // 租约还活着 → 不算中断（别人正在跑它）。
    harness.tasks.acquireLease(task.id, 'other-process');
    expect(harness.recovery.scan()).toEqual([]);

    // 租约过期 → 进入恢复清单。
    harness.advance(60_000);
    const items = harness.recovery.scan();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      taskId: task.id,
      status: 'in_progress',
      attempt: 1,
      step: { id: 's2', title: '写迁移' },
      sideEffect: 'none',
      action: 'auto_resume',
      requiresConfirmation: false,
      lease: { active: false, heldByOther: false },
    });

    // 已完成/已取消的任务永远不进清单。
    harness.tasks.cancel(task.id, { ifRevision: harness.tasks.get(task.id).revision });
    expect(harness.recovery.scan()).toEqual([]);
  });

  it('requires confirmation while a write tool is in flight', () => {
    const harness = makeHarness();
    const task = interruptedTask(harness);
    harness.tasks.setInFlight(task.id, {
      stepId: 's2',
      kind: 'tool',
      toolCallId: 'call-1',
      toolName: 'edit',
      startedAt: harness.now().toISOString(),
      sideEffect: 'write',
    });

    const item = harness.recovery.describeItem(task.id);
    expect(item).toMatchObject({
      sideEffect: 'write',
      action: 'manual_only',
      inFlightTool: 'edit',
      requiresConfirmation: true,
    });
    expect(item.reason).toContain('人工确认');

    // 未确认 → 409 task_needs_confirmation。
    expectError(
      () => harness.recovery.assertResumable(item, resume('continue')),
      409,
      'task_needs_confirmation',
    );
    // 确认后放行。
    expect(() => harness.recovery.assertResumable(item, resume('continue', true))).not.toThrow();
  });

  it('keeps a write marker after the tool ended until the step is retried', () => {
    const harness = makeHarness();
    const task = interruptedTask(harness);
    harness.tasks.setInFlight(task.id, {
      stepId: 's2',
      kind: 'tool',
      toolCallId: 'call-1',
      toolName: 'edit',
      startedAt: harness.now().toISOString(),
      sideEffect: 'write',
    });
    // 工具正常结束、但步骤还没标记完成 → 仍然不能当「两步之间」自动继续。
    harness.tasks.setInFlight(task.id, null);
    expect(harness.recovery.describeItem(task.id)).toMatchObject({
      sideEffect: 'write',
      action: 'manual_only',
    });

    // 重试该步骤（重置为 pending 再开始）后，旧标记失效 → 回到可自动继续。
    harness.tasks.resetCurrentStep(task.id);
    harness.advance(1_000);
    const started = harness.tasks.updateStep(task.id, 's2', {
      status: 'in_progress',
      ifRevision: harness.tasks.get(task.id).revision,
    });
    expect(started.steps[1].startedAt).toBeDefined();
    harness.tasks.setInFlight(task.id, null);
    expect(harness.recovery.describeItem(task.id)).toMatchObject({
      sideEffect: 'none',
      action: 'auto_resume',
    });
  });

  it('verifies file artifacts instead of guessing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-recovery-'));
    tempDirs.push(dir);
    const artifact = join(dir, 'migration.sql');
    const harness = makeHarness();
    const task = interruptedTask(harness, { verification: { kind: 'file', path: artifact } });
    harness.tasks.setInFlight(task.id, {
      stepId: 's2',
      kind: 'tool',
      toolCallId: 'call-1',
      toolName: 'write',
      startedAt: harness.now().toISOString(),
      sideEffect: 'write',
    });

    // 产物不存在 → 列出待验证产物；「是否放行」由执行器决定（要先把任务标 blocked）。
    const missing = harness.recovery.describeItem(task.id);
    expect(missing).toMatchObject({
      action: 'verify_then_resume',
      artifact: { path: artifact, exists: false },
    });
    expect(() => harness.recovery.assertResumable(missing, resume('continue'))).not.toThrow();
    expect(harness.recovery.applyArtifactVerification(missing)).toMatchObject({ verified: false });

    // 产物存在 → 自动验证通过，并把该步骤补记为完成（绝不重跑）。
    writeFileSync(artifact, 'CREATE TABLE t;', 'utf8');
    const present = harness.recovery.describeItem(task.id);
    expect(() => harness.recovery.assertResumable(present, resume('continue'))).not.toThrow();
    const verified = harness.recovery.applyArtifactVerification(present);
    expect(verified.verified).toBe(true);
    const after = harness.tasks.get(task.id);
    expect(after.steps[1]).toMatchObject({ status: 'completed' });
    expect(after.steps[1].evidence?.summary).toContain('迁移.sql'.replace('迁移', 'migration'));
    expect(after.status).toBe('completed');
  });
});

describe('TaskRecoveryService assertResumable', () => {
  it('rejects terminal tasks, missing sessions, replan and empty step lists', () => {
    const harness = makeHarness();
    const task = interruptedTask(harness);
    const item = harness.recovery.describeItem(task.id);

    expectError(
      () => harness.recovery.assertResumable({ ...item, status: 'completed' }, resume('continue')),
      409,
      'task_not_resumable',
    );
    expectError(
      () => harness.recovery.assertResumable({ ...item, sessionId: undefined }, resume('continue')),
      409,
      'task_session_missing',
    );
    expectError(
      () => harness.recovery.assertResumable(item, resume('replan')),
      409,
      'replan_unavailable',
    );
    expectError(
      () => harness.recovery.assertResumable({ ...item, step: undefined }, resume('continue')),
      409,
      'task_not_resumable',
    );

    const leased = { ...item, lease: { active: true, heldByOther: true, owner: 'other' } };
    expectError(
      () => harness.recovery.assertResumable(leased, resume('continue', true)),
      409,
      'task_leased',
    );
  });

  it('marks a task interrupted (blocked) without touching the lease of others', () => {
    const harness = makeHarness();
    const task = interruptedTask(harness);
    const blocked = harness.recovery.markInterrupted(task.id, '会话文件不存在，无法续跑');
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: '会话文件不存在，无法续跑' });
    expect(blocked.execution.inFlight).toBeUndefined();
    expect(blocked.execution.lease).toBeUndefined();
    // blocked 任务不再出现在恢复清单里（它已经在面板上等人处理）。
    expect(harness.recovery.scan()).toEqual([]);
  });
});

describe('lease helpers', () => {
  it('creates distinct owners per call (pid + bootId)', () => {
    const first = createLeaseOwner(1234);
    const second = createLeaseOwner(1234);
    expect(first.startsWith('1234-')).toBe(true);
    expect(first).not.toBe(second);
  });
});

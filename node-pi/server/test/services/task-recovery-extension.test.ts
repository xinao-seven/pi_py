import { describe, expect, it, vi } from 'vitest';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { MemoryTaskRepository } from '../../src/services/platform/task-repository.js';
import { TaskInFlightTracker } from '../../src/services/task-recovery-extension.js';
import { TaskService } from '../../src/services/task-service.js';
import type { TaskRecord } from '../../src/services/platform/task-model.js';

/** 捕获扩展注册的钩子（与 tool-approval 测试同样的做法）。 */
function makeFakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  return {
    handlers,
    on(channel: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(channel, handler);
    },
  };
}

const ctx = (sessionId = 'session-1') => ({ sessionManager: { getSessionId: () => sessionId } });

function makeHarness() {
  let clock = Date.UTC(2026, 7, 21, 10, 0, 0);
  const now = () => new Date(clock);
  const tasks = new TaskService(new MemoryTaskRepository(), {
    idFactory: () => 'task-1',
    now,
  });
  const settled: string[] = [];
  const tracker = new TaskInFlightTracker(tasks, {
    lookupActiveTask: () => 'task-1',
    onSettled: (sessionId) => settled.push(sessionId),
    now,
  });
  const pi = makeFakePi();
  tracker.buildExtension()(pi as unknown as ExtensionAPI);
  return {
    tasks,
    tracker,
    pi,
    settled,
    advance: (ms: number) => (clock += ms),
  };
}

function seedTask(tasks: TaskService): TaskRecord {
  const created = tasks.create({
    title: '重构 Plan 模式',
    goal: 'g',
    sessionId: 'session-1',
    cwd: '/workspace',
    steps: [{ title: '读实现' }, { title: '写迁移' }],
  });
  const first = tasks.updateStep(created.id, 's1', {
    status: 'completed',
    ifRevision: created.revision,
  });
  return tasks.updateStep(first.id, 's2', { status: 'in_progress', ifRevision: first.revision });
}

describe('TaskInFlightTracker', () => {
  it('records tool calls as in-flight marks with a side-effect classification', () => {
    const harness = makeHarness();
    seedTask(harness.tasks);

    harness.pi.handlers.get('turn_start')!({}, ctx());
    expect(harness.tasks.get('task-1').execution.inFlight).toMatchObject({
      kind: 'turn',
      sideEffect: 'none',
      stepId: 's2',
    });

    harness.pi.handlers.get('tool_execution_start')!(
      { toolName: 'edit', toolCallId: 'call-1', args: { path: 'a.ts' } },
      ctx(),
    );
    const inFlight = harness.tasks.get('task-1').execution.inFlight;
    expect(inFlight).toMatchObject({
      kind: 'tool',
      toolName: 'edit',
      toolCallId: 'call-1',
      sideEffect: 'write',
      stepId: 's2',
    });

    // 工具结束：清 inFlight，但保留 lastSideEffect（步骤未完成前不能当「无害」）。
    harness.pi.handlers.get('tool_execution_end')!({ toolName: 'edit' }, ctx());
    const execution = harness.tasks.get('task-1').execution;
    expect(execution.inFlight).toBeUndefined();
    expect(execution.lastSideEffect).toMatchObject({
      stepId: 's2',
      toolName: 'edit',
      sideEffect: 'write',
    });
  });

  it('clears in-flight on settle and notifies the runner once', () => {
    const harness = makeHarness();
    seedTask(harness.tasks);
    harness.pi.handlers.get('tool_execution_start')!(
      { toolName: 'read', toolCallId: 'call-2', args: {} },
      ctx(),
    );

    harness.pi.handlers.get('agent_settled')!({}, ctx());
    expect(harness.tasks.get('task-1').execution.inFlight).toBeUndefined();
    expect(harness.settled).toEqual(['session-1']);
  });

  it('injects the resume context once, hidden from the UI', () => {
    const harness = makeHarness();
    seedTask(harness.tasks);

    // 没有待注入内容时返回 undefined（不干扰正常轮次）。
    expect(harness.pi.handlers.get('before_agent_start')!({}, ctx())).toBeUndefined();

    harness.tracker.setPendingResume('session-1', '[TASK RESUME]\n继续第 2 步');
    const injected = harness.pi.handlers.get('before_agent_start')!({}, ctx()) as {
      message?: { customType?: string; content?: string; display?: boolean };
    };
    expect(injected.message).toMatchObject({
      customType: 'task-resume',
      display: false,
    });
    expect(injected.message?.content).toContain('[TASK RESUME]');
    // 一次性：第二次不再注入（否则每轮都会被塞一遍）。
    expect(harness.pi.handlers.get('before_agent_start')!({}, ctx())).toBeUndefined();
  });

  it('keeps only the last injected resume message in the model context', () => {
    const harness = makeHarness();
    const messages = [
      { role: 'user', content: 'hi' },
      { customType: 'task-resume', content: 'old' },
      { role: 'assistant', content: 'ok' },
      { customType: 'task-resume', content: 'new' },
    ];
    const result = harness.pi.handlers.get('context')!({ type: 'context', messages }, ctx()) as
      { messages: unknown[] } | undefined;

    expect(result?.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { customType: 'task-resume', content: 'new' },
    ]);
    // 没有 resume 消息时不改动（返回 undefined 让 SDK 跳过替换）。
    expect(
      harness.pi.handlers.get('context')!({ type: 'context', messages: [{ role: 'user' }] }, ctx()),
    ).toBeUndefined();
  });

  it('never lets a task write failure break the agent loop', () => {
    const harness = makeHarness();
    seedTask(harness.tasks);
    vi.spyOn(harness.tasks, 'setInFlight').mockImplementation(() => {
      throw new Error('db locked');
    });
    const warnings: string[] = [];
    const tracker = new TaskInFlightTracker(harness.tasks, {
      lookupActiveTask: () => 'task-1',
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (_obj, msg) => warnings.push(msg ?? ''),
        error: () => undefined,
      },
    });

    expect(() => tracker.noteToolStart('session-1', 'edit', 'call-1', {})).not.toThrow();
    expect(warnings).toContain('task in-flight update skipped');
  });

  it('ignores sessions without a bound task', () => {
    const harness = makeHarness();
    const tracker = new TaskInFlightTracker(harness.tasks);
    expect(() => tracker.noteTurnStart('unknown-session')).not.toThrow();
    expect(() => tracker.noteToolEnd('unknown-session')).not.toThrow();
    expect(() => tracker.takeResumeContext('unknown-session')).not.toThrow();
  });
});

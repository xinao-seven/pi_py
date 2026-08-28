import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ToolApprovalBroker,
  classifyBashCommand,
  findDangerousBashRule,
} from '../../src/services/tool-approval.js';

/** 在测试后 dispose 掉未结算的定时器。 */
const brokers: ToolApprovalBroker[] = [];
function makeBroker(timeoutMs = 5_000) {
  const broker = new ToolApprovalBroker({ timeoutMs });
  brokers.push(broker);
  return broker;
}

afterEach(() => {
  while (brokers.length) brokers.pop()!.dispose();
});

/** 构造带 tool_call 处理器捕获的假 Pi（用于端到端测试内联扩展）。 */
function makeFakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  return {
    handlers,
    on(channel: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(channel, handler);
    },
    async runToolCall(event: unknown, ctx: unknown) {
      const handler = handlers.get('tool_call');
      if (!handler) throw new Error('no tool_call handler registered');
      return handler(event, ctx);
    },
  };
}

/** 构造 tool_call 的上下文：hasUI=false 表示 Web 后端，true 表示 TUI/RPC。 */
function makeCtx(hasUI = false) {
  return {
    hasUI,
    sessionManager: { getSessionId: () => 'session-1' },
    signal: undefined as AbortSignal | undefined,
  };
}

/** 一条待审批项（与扩展/后端约定的载荷结构）。 */
function pendingCall(sessionId: string, toolCallId: string) {
  return {
    sessionId,
    toolCallId,
    toolName: 'bash',
    args: { command: 'rm -rf ./build' },
    reason: '递归或强制删除文件/目录，可能造成不可恢复的数据丢失',
    rule: 'recursive-delete',
    risk: 'critical' as const,
    category: 'destructive' as const,
  };
}

describe('dangerous command rules', () => {
  it('does not require approval for read-only shell inspection', () => {
    for (const command of ['find . -maxdepth 2 -type f', 'ls -la', 'git log --oneline -5']) {
      expect(findDangerousBashRule({ command })).toBeUndefined();
    }
  });

  it('recognizes destructive shell commands that require approval', () => {
    const rule = findDangerousBashRule({ command: 'rm -rf ./build' });

    expect(rule).toMatchObject({ name: 'recursive-delete' });
  });

  it('requires approval before deleting even a single file', () => {
    const rule = findDangerousBashRule({ command: 'rm ./notes.txt' });

    expect(rule).toMatchObject({ name: 'file-delete' });
  });

  it('classifies destructive commands as critical with an impact category', () => {
    expect(classifyBashCommand({ command: 'rm -rf ./build' })).toMatchObject({
      rule: 'recursive-delete',
      risk: 'critical',
      category: 'destructive',
    });
  });

  it('requires approval for dependency, network, and remote Git side effects', () => {
    expect(classifyBashCommand({ command: 'npm install fastify' })).toMatchObject({
      rule: 'dependency-change',
      risk: 'high',
      category: 'dependency_change',
    });
    expect(classifyBashCommand({ command: 'curl https://example.com' })).toMatchObject({
      rule: 'network-request',
      risk: 'medium',
      category: 'network',
    });
    expect(classifyBashCommand({ command: 'git push origin main' })).toMatchObject({
      rule: 'git-remote-write',
      risk: 'high',
      category: 'git_remote',
    });
  });
});

describe('ToolApprovalBroker', () => {
  it('records a pending request and notifies its listener', async () => {
    const broker = makeBroker();
    const listener = vi.fn();
    broker.setPendingListener(listener);

    const decision = broker.requestApproval(pendingCall('session-1', 'call-1'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(broker.pendingForSession('session-1')).toMatchObject({
      toolCallId: 'call-1',
      rule: 'recursive-delete',
      risk: 'critical',
      category: 'destructive',
    });
    broker.decide('session-1', 'call-1', true);
    await expect(decision).resolves.toBe(true);
  });

  it('decide() rejects unknown call ids and settles known ones', async () => {
    const broker = makeBroker();
    const decision = broker.requestApproval(pendingCall('session-1', 'call-1'));

    expect(() => broker.decide('session-1', 'missing', true)).toThrow(/no longer pending/);
    broker.decide('session-1', 'call-1', false);
    await expect(decision).resolves.toBe(false);
  });

  it('clears the pending snapshot once a call is settled', async () => {
    const broker = makeBroker();
    const decision = broker.requestApproval(pendingCall('session-1', 'call-1'));
    expect(broker.pendingForSession('session-1')).toBeDefined();

    broker.decide('session-1', 'call-1', true);
    await decision;

    expect(broker.pendingForSession('session-1')).toBeUndefined();
  });

  it('rejects by default when the decision timeout expires', async () => {
    const broker = makeBroker(10);

    const decision = broker.requestApproval(pendingCall('session-1', 'call-1'));

    await expect(decision).resolves.toBe(false);
    expect(broker.pendingForSession('session-1')).toBeUndefined();
  });

  it('cancelSession() rejects all pending calls of that session', async () => {
    const broker = makeBroker();
    const decisions = [
      broker.requestApproval(pendingCall('session-1', 'call-1')),
      broker.requestApproval(pendingCall('session-1', 'call-2')),
      broker.requestApproval(pendingCall('session-2', 'call-3')),
    ];

    broker.cancelSession('session-1');

    await expect(decisions[0]).resolves.toBe(false);
    await expect(decisions[1]).resolves.toBe(false);
    expect(broker.pendingForSession('session-1')).toBeUndefined();
    expect(broker.pendingForSession('session-2')).toBeDefined();
    broker.decide('session-2', 'call-3', true);
    await expect(decisions[2]).resolves.toBe(true);
  });

  it('settles the pending call as rejected when the signal aborts', async () => {
    const broker = makeBroker();
    const controller = new AbortController();

    const decision = broker.requestApproval(pendingCall('session-1', 'call-1'), controller.signal);

    controller.abort();
    await expect(decision).resolves.toBe(false);
    expect(broker.pendingForSession('session-1')).toBeUndefined();
  });

  it('dispose() settles remaining pendings', async () => {
    const broker = makeBroker();
    const listener = vi.fn();
    broker.setPendingListener(listener);

    const decision = broker.requestApproval(pendingCall('session-1', 'call-1'));
    expect(broker.pendingForSession('session-1')).toBeDefined();

    broker.dispose();
    await expect(decision).resolves.toBe(false);
    expect(broker.pendingForSession('session-1')).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores a duplicate request for the same call id', async () => {
    const broker = makeBroker();
    const listener = vi.fn();
    broker.setPendingListener(listener);

    const first = broker.requestApproval(pendingCall('session-1', 'call-1'));
    const second = broker.requestApproval(pendingCall('session-1', 'call-1'));

    expect(listener).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe(false);
    broker.decide('session-1', 'call-1', true);
    await expect(first).resolves.toBe(true);
  });
});

describe('approval extension (buildExtension)', () => {
  it('approves a dangerous bash call when the broker decides true', async () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    const ctx = makeCtx();

    const result = pi.runToolCall(
      { toolName: 'bash', toolCallId: 'call-1', input: { command: 'rm -rf ./build' } },
      ctx,
    );

    expect(broker.pendingForSession('session-1')).toMatchObject({
      toolCallId: 'call-1',
      rule: 'recursive-delete',
      risk: 'critical',
      category: 'destructive',
    });
    broker.decide('session-1', 'call-1', true);
    await expect(result).resolves.toBeUndefined();
    expect(broker.pendingForSession('session-1')).toBeUndefined();
  });

  it('blocks a dangerous bash call when the broker decides false', async () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    const ctx = makeCtx();

    const result = pi.runToolCall(
      { toolName: 'bash', toolCallId: 'call-2', input: { command: 'shutdown /s' } },
      ctx,
    );

    broker.decide('session-1', 'call-2', false);
    await expect(result).resolves.toEqual({
      block: true,
      reason: 'Tool execution was not approved',
    });
  });

  it('blocks by default when the broker decision timeout expires', async () => {
    const broker = makeBroker(10);
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    const ctx = makeCtx();

    const result = pi.runToolCall(
      { toolName: 'bash', toolCallId: 'call-3', input: { command: 'rm ./notes.txt' } },
      ctx,
    );

    await expect(result).resolves.toEqual({
      block: true,
      reason: 'Tool execution was not approved',
    });
    expect(broker.pendingForSession('session-1')).toBeUndefined();
  });

  it('blocks pending calls when the session is cancelled', async () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    const ctx = makeCtx();

    const result = pi.runToolCall(
      {
        toolName: 'bash',
        toolCallId: 'call-4',
        input: { command: 'git push --force origin main' },
      },
      ctx,
    );

    broker.cancelSession('session-1');
    await expect(result).resolves.toEqual({
      block: true,
      reason: 'Tool execution was not approved',
    });
  });

  it('blocks when the call is aborted via AbortSignal', async () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    const controller = new AbortController();
    const ctx = makeCtx();
    ctx.signal = controller.signal;

    const result = pi.runToolCall(
      { toolName: 'bash', toolCallId: 'call-8', input: { command: 'rm ./notes.txt' } },
      ctx,
    );

    controller.abort();
    await expect(result).resolves.toEqual({
      block: true,
      reason: 'Tool execution was not approved',
    });
    expect(broker.pendingForSession('session-1')).toBeUndefined();
  });

  it('does not intercept non-bash tools or safe bash commands', async () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);
    const ctx = makeCtx();

    await expect(
      pi.runToolCall({ toolName: 'read', toolCallId: 'call-5', input: { filePath: 'a.txt' } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      pi.runToolCall({ toolName: 'bash', toolCallId: 'call-6', input: { command: 'ls -la' } }, ctx),
    ).resolves.toBeUndefined();
    expect(broker.pendingForSession('session-1')).toBeUndefined();
  });

  it('does not intercept dangerous bash in TUI/RPC (hasUI=true), which have their own confirm UI', async () => {
    const broker = makeBroker();
    const pi = makeFakePi();
    broker.buildExtension()(pi as never);

    const result = pi.runToolCall(
      { toolName: 'bash', toolCallId: 'call-7', input: { command: 'rm -rf ./build' } },
      makeCtx(true),
    );

    await expect(result).resolves.toBeUndefined();
    expect(broker.pendingForSession('session-1')).toBeUndefined();
  });
});

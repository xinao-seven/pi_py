import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentRegistry,
  type CreateSessionInput,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';
import { ToolApprovalBroker } from '../../src/services/tool-approval.js';
import { SessionLedger } from '../../src/services/observability/session-ledger.js';
import { openPlatformStore, type PlatformStore } from '../../src/services/platform/store.js';

const tempDirs: string[] = [];
const stores: PlatformStore[] = [];
const brokers: ToolApprovalBroker[] = [];

afterEach(() => {
  while (brokers.length) brokers.pop()!.dispose();
  while (stores.length) stores.pop()!.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 每次 create() 产生一个新会话（parent-1、parent-2…），并记录创建输入。 */
class MultiSessionFactory implements PiSessionFactory {
  readonly inputs: CreateSessionInput[] = [];
  readonly sessions: FakeSession[] = [];
  private counter = 0;

  async create(input: CreateSessionInput): Promise<PiSession> {
    this.counter += 1;
    this.inputs.push(input);
    const session = new FakeSession(`session-${this.counter}`);
    this.sessions.push(session);
    return session;
  }
}

class FakeSession implements PiSession {
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'deepseek', id: 'deepseek-v4-flash' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  readonly sessionManager = {
    getSessionFile: () => `/tmp/${this.sessionId}.jsonl`,
    getSessionId: () => this.sessionId,
  };
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(readonly sessionId: string) {}

  getActiveToolNames(): string[] {
    return ['bash'];
  }
  subscribe(listener: (event: never) => void): () => void {
    this.listeners.add(listener as (event: unknown) => void);
    return () => this.listeners.delete(listener as (event: unknown) => void);
  }
  emit(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  async prompt(): Promise<void> {}
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

/** 一套完整装配：注册表 + 真实审批中枢 + 真实账本（内存 trace 存储）。 */
async function makeHarness() {
  const store = openPlatformStore({ mode: 'memory' });
  stores.push(store);
  const ledger = new SessionLedger(store.traces);
  const broker = new ToolApprovalBroker({ timeoutMs: 10_000 });
  brokers.push(broker);
  const factory = new MultiSessionFactory();
  const registry = new AgentRegistry(factory, broker, undefined, undefined, ledger);
  const cwd = mkdtempSync(join(tmpdir(), 'pi-subagent-approval-'));
  tempDirs.push(cwd);

  const parent = await registry.create({ cwd });
  const child = await registry.create({
    cwd,
    subagent: {
      parentSessionId: parent.session.sessionId,
      parentRunId: 'run-parent-1',
      preset: 'scout',
      depth: 1,
      maxDepth: 1,
    },
  });
  return { registry, broker, ledger, factory, parent, child, store, cwd };
}

/** 用真实内联扩展触发一次危险命令（走 resolver + 事件广播的完整链路）。 */
async function requestDangerousBash(broker: ToolApprovalBroker, sessionId: string) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  (broker.buildExtension() as unknown as (pi: unknown) => void)({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(name, handler),
  });
  return handlers.get('tool_call')!(
    { toolName: 'bash', toolCallId: 'call-danger', input: { command: 'rm -rf ./build' } },
    { hasUI: false, sessionManager: { getSessionId: () => sessionId }, signal: undefined },
  );
}

describe('子会话的审批继承（M5）', () => {
  it('announces a child approval on the parent stream, labelled with the preset', async () => {
    const { registry, broker, parent, child } = await makeHarness();
    const events: Array<Record<string, unknown>> = [];
    registry.subscribe(parent.session.sessionId, 0, (event) => events.push(event.payload as never));
    // 子会话自己也订阅上，验证「两边都发」的分支
    const childEvents: Array<Record<string, unknown>> = [];
    registry.subscribe(child.session.sessionId, 0, (event) =>
      childEvents.push(event.payload as never),
    );

    const pending = requestDangerousBash(broker, child.session.sessionId);

    const announced = events.find((event) => event.type === 'tool_call_pending');
    expect(announced).toMatchObject({
      type: 'tool_call_pending',
      toolCallId: 'call-danger',
      rule: 'recursive-delete',
      risk: 'critical',
      // 弹窗显示在父会话上：既要标出「谁在等」，也要标出「谁要执行」
      parentSessionId: parent.session.sessionId,
      sessionId: child.session.sessionId,
      agent: 'scout',
    });
    expect(childEvents.some((event) => event.type === 'tool_call_pending')).toBe(true);

    // 前端只用父会话 id 就能结算（子会话的 pending 由父会话决定）
    registry.approveTool(parent.session.sessionId, 'call-danger', true);
    await expect(pending).resolves.toBeUndefined();
  });

  it('does not stamp a parent for top-level sessions', async () => {
    const { registry, broker, parent } = await makeHarness();
    const events: Array<Record<string, unknown>> = [];
    registry.subscribe(parent.session.sessionId, 0, (event) => events.push(event.payload as never));

    const pending = requestDangerousBash(broker, parent.session.sessionId);
    const announced = events.find((event) => event.type === 'tool_call_pending');
    expect(announced).toBeDefined();
    expect(announced).not.toHaveProperty('parentSessionId');
    registry.approveTool(parent.session.sessionId, 'call-danger', false);
    await pending;
  });

  it('rejects child pendings when the parent session is cancelled', async () => {
    const { registry, broker, parent, child } = await makeHarness();
    const pending = requestDangerousBash(broker, child.session.sessionId);
    registry.get(parent.session.sessionId); // 父会话仍在注册表里
    broker.cancelSession(parent.session.sessionId);
    await expect(pending).resolves.toMatchObject({
      block: true,
      reason: 'Tool execution was not approved',
    });
  });

  it('links the child run to the parent run with preset/depth metadata', async () => {
    const { registry, child, store } = await makeHarness();
    // 子会话跑一轮：agent_start 建 run，agent_settled 收尾
    child.session.emit({ type: 'agent_start' });
    child.session.emit({ type: 'turn_start' });
    child.session.emit({ type: 'agent_settled' });

    const runs = store.traces.listRuns({ limit: 10 }).runs;
    const childRun = runs.find((run) => run.sessionId === child.session.sessionId);
    expect(childRun).toBeDefined();
    expect(childRun?.parentRunId).toBe('run-parent-1');
    expect(childRun?.meta).toMatchObject({ preset: 'scout', depth: 1 });
    // 父 run id 来自创建子会话时父会话正在跑的 run（此处由测试注入）
    expect(store.traces.getRun(childRun!.id)?.children).toEqual([]);
    registry.get(child.session.sessionId);
  });

  it('inherits the parent task id so delegated work counts towards the task', async () => {
    const { registry, child } = await makeHarness();
    const parentId = 'session-1';
    registry.setActiveTask(parentId, 'task-42');
    const second = await registry.create({
      cwd: join(process.cwd()),
      subagent: {
        parentSessionId: parentId,
        parentRunId: 'run-1',
        preset: 'worker',
        depth: 1,
        maxDepth: 1,
      },
    });
    // 新子会话继承父会话当前任务，成本/步骤算在任务头上
    expect(registry.get(second.session.sessionId)?.activeTaskId).toBe('task-42');
    expect(child.session.sessionId).toBe('session-2');
  });
});

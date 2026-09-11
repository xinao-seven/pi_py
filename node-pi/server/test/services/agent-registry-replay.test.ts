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

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 假会话：subscribe 只登记监听器，emit() 用来模拟 SDK 推事件。 */
class FakeSession implements PiSession {
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'deepseek', id: 'deepseek-v4-flash' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
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

class OneSessionFactory implements PiSessionFactory {
  session: FakeSession | undefined;
  async create(input: CreateSessionInput): Promise<PiSession> {
    void input;
    this.session = new FakeSession('session-replay');
    return this.session;
  }
}

async function makeRegistry() {
  const factory = new OneSessionFactory();
  const registry = new AgentRegistry(factory);
  const cwd = mkdtempSync(join(tmpdir(), 'pi-replay-coalesce-'));
  tempDirs.push(cwd);
  const entry = await registry.create({ cwd });
  return { registry, session: factory.session!, sessionId: entry.session.sessionId };
}

function messageUpdate(text: string) {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/**
 * 重放合并：缓存里同一段流式输出会有几百条 message_update（每条带整条消息快照），
 * 逐条补发等于让客户端一建连就重渲染几百次。重放只保留连续段的最后一条，
 * 但实时订阅路径必须一条不少。
 */
describe('AgentRegistry 的 SSE 重放合并', () => {
  it('collapses consecutive message_update frames in the replay', async () => {
    const { registry, session, sessionId } = await makeRegistry();
    for (const text of ['a', 'ab', 'abc', 'abcd', 'abcde']) session.emit(messageUpdate(text));
    session.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: {} });

    const replay: Array<{ id: number; payload: Record<string, unknown> }> = [];
    registry.subscribe(sessionId, 0, (event) =>
      replay.push({ id: event.id, payload: event.payload as never }),
    );

    const updates = replay.filter((entry) => entry.payload.type === 'message_update');
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0]!.payload)).toContain('abcde');
    // 非 message_update 的事件一条都不能少（顺序与内容原样保留）。
    expect(replay.map((entry) => entry.payload.type)).toEqual([
      'message_update',
      'tool_execution_start',
    ]);

    // 断线重连：从「最后一条增量之前」续传，同样只补一条增量。
    const tail: unknown[] = [];
    registry.subscribe(sessionId, replay[0]!.id - 1, (event) => tail.push(event.payload.type));
    expect(tail).toEqual(['message_update', 'tool_execution_start']);
  });

  it('keeps every event on the live path', async () => {
    const { registry, session, sessionId } = await makeRegistry();
    const live: Array<Record<string, unknown>> = [];
    registry.subscribe(sessionId, 0, (event) => live.push(event.payload as never));

    for (const text of ['a', 'ab', 'abc']) session.emit(messageUpdate(text));

    expect(live.filter((event) => event.type === 'message_update')).toHaveLength(3);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createApp } from '../../../src/app.js';
import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
} from '../../../src/services/agent-registry.js';
import { SessionLedger } from '../../../src/services/observability/session-ledger.js';
import { openPlatformStore, type PlatformStore } from '../../../src/services/platform/store.js';
import type { TraceConfig } from '../../../src/config.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-registry-ledger-'));
  tempDirs.push(dir);
  return dir;
}

const stores: PlatformStore[] = [];

afterEach(() => {
  while (stores.length) {
    try {
      stores.pop()!.close();
    } catch {
      // 已关闭：忽略
    }
  }
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 假会话：prompt() 时按脚本发一轮完整事件。 */
class ScriptedSession implements PiSession {
  readonly sessionId = 'session-1';
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'test', id: 'fake' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  /** 让 prompt() 失败，用于验证命令级失败也会被记账。 */
  failPrompt = false;
  private readonly listeners = new Set<(event: unknown) => void>();

  getActiveToolNames(): string[] {
    return ['bash'];
  }
  subscribe(listener: (event: never) => void): () => void {
    this.listeners.add(listener as (event: unknown) => void);
    return () => this.listeners.delete(listener as (event: unknown) => void);
  }
  async bindExtensions(): Promise<void> {}
  emit(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  async prompt(): Promise<void> {
    if (this.failPrompt) throw new Error('no model selected');
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });
    this.emit({ type: 'message_update', message: { role: 'assistant' } });
    this.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'test',
        model: 'fake',
        stopReason: 'toolUse',
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      },
    });
    this.emit({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    this.emit({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { ok: true },
      isError: false,
    });
    this.emit({ type: 'agent_settled' });
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  async setModel(model: { provider: string; id: string }): Promise<void> {
    this.model = model;
  }
  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }
  setActiveToolsByName(): void {}
  async compact(): Promise<void> {}
  async navigateTree(): Promise<void> {}
  async reload(): Promise<void> {}
  dispose(): void {}
}

class ScriptedFactory implements PiSessionFactory {
  readonly session = new ScriptedSession();
  createCounter = 0;
  async create(): Promise<PiSession> {
    this.createCounter += 1;
    return this.session;
  }
}

const traceConfig = (dbPath: string, enabled = true): TraceConfig => ({
  enabled,
  mode: 'sqlite',
  dbPath,
  content: false,
  flushMs: 250,
  batchSize: 200,
  maxPending: 5_000,
});

describe('AgentRegistry → SessionLedger wiring', () => {
  it('records a run and its steps from the session event stream', async () => {
    const store = openPlatformStore({ mode: 'memory' });
    stores.push(store);
    const factory = new ScriptedFactory();
    const registry = new AgentRegistry(
      factory,
      undefined,
      undefined,
      undefined,
      new SessionLedger(store.traces, undefined, { runIdFactory: () => 'run-1' }),
    );

    await registry.create({ cwd: '/workspace' });
    await registry.command('session-1', { type: 'prompt', message: 'hi' });

    const detail = store.traces.getRun('run-1');
    expect(detail?.run).toMatchObject({
      sessionId: 'session-1',
      cwd: '/workspace',
      provider: 'test',
      model: 'fake',
      status: 'completed',
      turns: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    });
    expect(detail?.steps.map((step) => step.kind)).toEqual(['llm_call', 'tool_call']);
    expect(detail?.steps[1]).toMatchObject({ toolName: 'bash', isError: false });
    await registry.close();
  });

  it('records a failed run when prompt() rejects', async () => {
    const store = openPlatformStore({ mode: 'memory' });
    stores.push(store);
    const factory = new ScriptedFactory();
    factory.session.failPrompt = true;
    const registry = new AgentRegistry(
      factory,
      undefined,
      undefined,
      undefined,
      new SessionLedger(store.traces, undefined, { runIdFactory: () => 'run-failed' }),
    );

    await registry.create({ cwd: '/workspace' });
    await registry.command('session-1', { type: 'prompt', message: 'hi' });
    // prompt() 的 reject 是异步的：等一个微任务周期再断言。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.traces.getRun('run-failed')?.run).toMatchObject({
      status: 'error',
      errorType: 'command_error',
      errorMessage: 'no model selected',
    });
    await registry.close();
  });

  it('finalizes an open run when the session is removed', async () => {
    const store = openPlatformStore({ mode: 'memory' });
    stores.push(store);
    const factory = new ScriptedFactory();
    const registry = new AgentRegistry(
      factory,
      undefined,
      undefined,
      undefined,
      new SessionLedger(store.traces, undefined, { runIdFactory: () => 'run-open' }),
    );

    await registry.create({ cwd: '/workspace' });
    factory.session.emit({ type: 'agent_start' });
    factory.session.emit({ type: 'turn_start' });
    await registry.remove('session-1');

    expect(store.traces.getRun('run-open')?.run.status).toBe('aborted');
    await registry.close();
  });
});

describe('trace configuration regression', () => {
  it('writes no trace rows when trace is disabled (tasks still persist)', async () => {
    const dbPath = join(tempDir(), 'platform.db');
    const app = createApp({
      trace: traceConfig(dbPath, false),
      registry: new AgentRegistry(new ScriptedFactory()),
    });

    await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: process.cwd(), message: 'hello' },
    });
    const summary = await app.inject({ method: 'GET', url: '/api/observability/summary' });
    expect(summary.json().store).toMatchObject({ mode: 'off' });
    expect(summary.json().totals.runs).toBe(0);
    await app.close();

    // 任务（M2）是需要持久化的业务状态，与 trace 开关解耦，因此库仍会被建立；
    // 但 trace 明细表必须一行都不写——这就是「关掉 trace 行为不变」的回归证据。
    expect(existsSync(dbPath)).toBe(true);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toMatchObject({ n: 0 });
    db.close();
  });

  it('touches no disk at all when the store is memory-backed', async () => {
    const dbPath = join(tempDir(), 'platform.db');
    const app = createApp({
      trace: { ...traceConfig(dbPath, false), mode: 'memory' },
      registry: new AgentRegistry(new ScriptedFactory()),
    });

    await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: process.cwd(), message: 'hello' },
    });
    const tasks = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 't', goal: 'g' },
    });
    expect(tasks.statusCode).toBe(200);
    await app.close();

    expect(existsSync(dbPath)).toBe(false);
  });
});

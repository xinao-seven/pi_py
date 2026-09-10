import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentRegistry,
  type CreateSessionInput,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';
import {
  SubagentService,
  SUBAGENT_EXTENSIONS,
  DEFAULT_SUBAGENT_LIMITS,
} from '../../src/services/subagent-service.js';
import type { SessionLedger } from '../../src/services/observability/session-ledger.js';

const tempDirs: string[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** 一个可编排的子会话替身：事件可控、prompt 可挂起。 */
class FakeSession implements PiSession {
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'deepseek', id: 'deepseek-v4-flash' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  readonly prompts: string[] = [];
  aborted = false;
  disposed = false;
  private readonly listeners = new Set<(event: unknown) => void>();
  private release?: () => void;
  /** false 时 prompt() 会挂起等 settle()，供「运行中事件/取消」类用例使用。 */
  autoRun = true;

  constructor(
    readonly sessionId: string,
    private readonly behaviour: (session: FakeSession) => Promise<void>,
  ) {}

  emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(event);
  }

  /** 让挂起的 prompt 结束。 */
  settle(): void {
    this.release?.();
  }

  getActiveToolNames(): string[] {
    return [];
  }
  subscribe(listener: (event: never) => void): () => void {
    this.listeners.add(listener as (event: unknown) => void);
    return () => this.listeners.delete(listener as (event: unknown) => void);
  }
  async prompt(message: string): Promise<void> {
    this.prompts.push(message);
    this.isStreaming = true;
    if (!this.autoRun) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    this.isStreaming = false;
    await this.behaviour(this);
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {
    this.aborted = true;
    this.release?.();
  }
  async setModel(): Promise<void> {}
  setThinkingLevel(): void {}
  setActiveToolsByName(): void {}
  async compact(): Promise<void> {}
  async navigateTree(): Promise<void> {}
  async reload(): Promise<void> {}
  dispose(): void {
    this.disposed = true;
  }
}

/** 记录创建输入的假工厂：默认「跑完就返回一段摘要」。 */
class FakeFactory implements PiSessionFactory {
  readonly inputs: CreateSessionInput[] = [];
  readonly sessions: FakeSession[] = [];
  /** 每个子会话的脚本（按创建顺序取）；返回 undefined 表示用默认脚本。 */
  scripts: Array<((session: FakeSession) => Promise<void>) | undefined> = [];
  /** true 时子会话的 prompt() 挂起等 settle()（运行中事件/取消类用例）。 */
  manualControl = false;
  resolveSubagentModel = vi.fn(
    async (input: { spec?: string; fallback?: { provider: string; id: string } }) => ({
      ...(input.fallback === undefined ? {} : { model: input.fallback }),
    }),
  );

  async create(input: CreateSessionInput): Promise<PiSession> {
    this.inputs.push(input);
    const script = this.scripts[this.sessions.length];
    const session = new FakeSession(
      `child-${this.sessions.length + 1}`,
      script ??
        (async (self) => {
          self.messages = [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '子任务完成：找到 2 个入口文件。' }],
              stopReason: 'stop',
            },
          ];
        }),
    );
    session.autoRun = !this.manualControl;
    this.sessions.push(session);
    return session;
  }
}

interface Harness {
  service: SubagentService;
  factory: FakeFactory;
  registry: AgentRegistry;
  agentDir: string;
  cwd: string;
}

let parentSession: FakeSession | undefined;

function makeHarness(
  options: {
    limits?: Partial<typeof DEFAULT_SUBAGENT_LIMITS>;
    presets?: Array<{ name: string; tools?: string[]; model?: string; body?: string }>;
    withParent?: boolean;
    /** 子会话挂起等 settle()（「运行中」类用例需要手动推事件）。 */
    manual?: boolean;
  } = {},
): Harness {
  const agentDir = makeTemp('pi-agent-');
  const cwd = makeTemp('pi-cwd-');
  const agentsDir = join(agentDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const presets = options.presets ?? [
    { name: 'scout', tools: ['read', 'grep', 'find', 'ls'] },
    { name: 'worker', body: '你是全能工人。' },
  ];
  for (const preset of presets) {
    writeFileSync(
      join(agentsDir, `${preset.name}.md`),
      [
        '---',
        `name: ${preset.name}`,
        `description: ${preset.name} 预设`,
        ...(preset.tools === undefined ? [] : [`tools: ${preset.tools.join(', ')}`]),
        ...(preset.model === undefined ? [] : [`model: ${preset.model}`]),
        '---',
        '',
        preset.body ?? `${preset.name} 的系统提示词`,
      ].join('\n'),
      'utf8',
    );
  }

  const factory = new FakeFactory();
  factory.manualControl = options.manual === true;
  const registry = new AgentRegistry(factory);
  const service = new SubagentService({
    agentDir,
    limits: options.limits,
    sessionDir: join(agentDir, 'subagents'),
  });
  const ledger = {
    currentRunId: (sessionId: string) => (sessionId === 'parent' ? 'parent-run' : undefined),
    lastRunId: (sessionId: string) => `run-of-${sessionId}`,
    finalizeSession: () => undefined,
  } as unknown as SessionLedger;
  service.attach({ registry, factory, ledger });

  if (options.withParent !== false) {
    parentSession = new FakeSession('parent', async () => undefined);
    // 直接把父会话塞进注册表（子会话需要能查到父会话的模型与 JSONL 路径）。
    void registry['register'](parentSession, cwd, new Date());
  }
  return { service, factory, registry, agentDir, cwd };
}

describe('SubagentService：委派一次子任务', () => {
  it('creates the child session with preset isolation, own session dir and parent link', async () => {
    const { service, factory, agentDir, cwd } = makeHarness();
    const result = await service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: '找出所有入口文件',
      depth: 1,
    });

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('入口文件');
    expect(result.subagentSessionId).toBe('child-1');
    expect(result.runId).toBe('run-of-child-1');
    expect(result.depth).toBe(1);

    const input = factory.inputs[0];
    // 子会话落在本项目私有目录，不进共享的 ~/.pi/agent/sessions
    expect(input.cwd).toBe(cwd);
    expect(input.subagent).toMatchObject({
      parentSessionId: 'parent',
      parentRunId: 'parent-run',
      preset: 'scout',
      depth: 1,
      sessionDir: join(agentDir, 'subagents'),
      maxDepth: 1,
    });
    // 只读预设就是只读：工具白名单不被并入任何内联工具（MCP / 计划 / ask_user）
    expect(input.toolNames).toEqual(['read', 'grep', 'find', 'ls']);
    // 子会话不问用户、不自己规划
    expect(input.extensions).toEqual(SUBAGENT_EXTENSIONS);
    expect(input.extensions).toEqual({ approval: true, planMode: false, questions: false });
    expect(input.systemPrompt).toContain('scout 的系统提示词');
    // 未指定模型 → 继承父会话
    expect(input.provider).toBe('deepseek');
    expect(input.modelId).toBe('deepseek-v4-flash');
    // 子会话用完即释放（JSONL 留在磁盘上）
    expect(factory.sessions[0].disposed).toBe(true);
    expect(service.runningList()).toEqual([]);
  });

  it('returns the usage and tool trajectory collected from child events', async () => {
    const { service, factory, cwd } = makeHarness({ manual: true });
    factory.scripts = [
      async (self) => {
        self.messages = [
          { role: 'assistant', content: [{ type: 'text', text: '完毕' }], stopReason: 'stop' },
        ];
      },
    ];
    const running = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 1,
    });
    // 让出事件循环，等子会话被创建并开始跑
    await new Promise((resolve) => setTimeout(resolve, 0));
    const child = factory.sessions[0];
    child.emit({ type: 'turn_start' });
    child.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '完毕' }],
        stopReason: 'stop',
        usage: { input: 1200, output: 300, cacheRead: 100, cost: { total: 0 } },
      },
    });
    child.emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'grep', isError: false });
    child.emit({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'read', isError: false });
    child.settle();
    const result = await running;

    expect(result.usage).toMatchObject({
      turns: 1,
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 100,
    });
    expect(result.trajectory).toEqual([
      { tool: 'grep', ok: true },
      { tool: 'read', ok: true },
    ]);
  });

  it('aborts and reports when the turn budget is exceeded, keeping the partial summary', async () => {
    const { service, factory, cwd } = makeHarness({
      manual: true,
      presets: [{ name: 'scout', tools: ['read'] }],
    });
    factory.scripts = [
      async (self) => {
        self.messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '已完成一半' }],
            stopReason: 'stop',
          },
        ];
      },
    ];
    const running = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 1,
      budget: { maxTurns: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const child = factory.sessions[0];
    child.emit({ type: 'turn_start' });
    child.emit({ type: 'turn_start' });
    child.emit({ type: 'turn_start' }); // 第 3 轮 → 超限
    expect(child.aborted).toBe(true);
    child.settle();
    const result = await running;

    expect(result.status).toBe('budget_exceeded');
    expect(result.reason).toContain('最大轮数 2');
    expect(result.summary).toContain('已完成一半');
  });

  it('aborts when the token budget is exceeded', async () => {
    const { service, factory, cwd } = makeHarness({
      manual: true,
      presets: [{ name: 'scout', tools: ['read'] }],
    });
    const running = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 1,
      budget: { maxTokens: 1000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const child = factory.sessions[0];
    child.emit({
      type: 'message_end',
      message: { role: 'assistant', usage: { input: 1500, output: 10 } },
    });
    expect(child.aborted).toBe(true);
    child.settle();
    const result = await running;
    expect(result.status).toBe('budget_exceeded');
    expect(result.reason).toContain('token 预算');
  });

  it('aborts on timeout', async () => {
    const { service, factory, cwd } = makeHarness({
      manual: true,
      presets: [{ name: 'scout', tools: ['read'] }],
    });
    const running = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 1,
      budget: { timeoutMs: 5 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(factory.sessions[0].aborted).toBe(true);
    factory.sessions[0].settle();
    const result = await running;
    expect(result.status).toBe('timeout');
    expect(result.reason).toContain('时限');
  });

  it('reports a failed status when the child model errors', async () => {
    const { service, factory, cwd } = makeHarness({
      presets: [{ name: 'scout', tools: ['read'] }],
    });
    factory.scripts = [
      async (self) => {
        self.messages = [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '出错了' }],
            stopReason: 'error',
            errorMessage: 'model exploded',
          },
        ];
      },
    ];
    const running = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    factory.sessions[0].settle();
    const result = await running;
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('model exploded');
  });
});

describe('SubagentService：边界与安全', () => {
  it('refuses an unknown preset and lists the available ones', async () => {
    const { service, factory, cwd } = makeHarness();
    const result = await service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'nope',
      prompt: 'p',
      depth: 1,
    });
    expect(result.status).toBe('failed');
    expect(result.missingPresets).toEqual(['scout', 'worker']);
    expect(result.summary).toContain('scout');
    expect(factory.inputs).toHaveLength(0);
  });

  it('refuses to delegate beyond the depth limit (no child session created)', async () => {
    const { service, factory, cwd } = makeHarness();
    const result = await service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 2,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('深度上限 1');
    expect(factory.inputs).toHaveLength(0);
  });

  it('reports unavailable when the service is not attached', async () => {
    const service = new SubagentService({ agentDir: makeTemp('pi-agent-') });
    const result = await service.run({
      parentSessionId: 'parent',
      cwd: process.cwd(),
      preset: 'scout',
      prompt: 'p',
      depth: 1,
    });
    expect(result.status).toBe('unavailable');
  });

  it('does not register the tool extension at the depth limit', async () => {
    const { service } = makeHarness();
    const registered: string[] = [];
    const fakePi = {
      registerTool: (tool: { name: string }) => registered.push(tool.name),
    };
    await (service.buildExtension({ depth: 1 }) as unknown as (pi: unknown) => void)(fakePi);
    expect(registered).toEqual(['subagent']);

    // 深度为 0 的用户会话同样可以委派（子会话深度 = 1）
    registered.length = 0;
    await (service.buildExtension({ depth: 0 }) as unknown as (pi: unknown) => void)(fakePi);
    expect(registered).toEqual(['subagent']);
  });
});

describe('SubagentService：并发与取消', () => {
  it('queues beyond maxConcurrent and starts the rest after release', async () => {
    const { service, factory, cwd } = makeHarness({
      manual: true,
      limits: { maxConcurrent: 2, maxPerParent: 4 },
    });
    const runs = [1, 2, 3].map((index) =>
      service.run({
        parentSessionId: 'parent',
        cwd,
        preset: 'scout',
        prompt: `task ${index}`,
        depth: 1,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 只启动 2 个（第 3 个还在排队）
    expect(factory.sessions).toHaveLength(2);
    expect(service.activeCount()).toBe(2);
    expect(service.runningList()).toHaveLength(2);

    factory.sessions[0].settle();
    await runs[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 释放一个名额后第 3 个才被创建
    expect(factory.sessions).toHaveLength(3);

    for (const session of factory.sessions.slice(1)) session.settle();
    const results = await Promise.all(runs);
    expect(results.map((result) => result.status)).toEqual(['completed', 'completed', 'completed']);
    expect(service.activeCount()).toBe(0);
  });

  it('queues per parent as well (maxPerParent)', async () => {
    const { service, factory, cwd } = makeHarness({
      manual: true,
      limits: { maxConcurrent: 4, maxPerParent: 1 },
    });
    const runs = [1, 2].map((index) =>
      service.run({
        parentSessionId: 'parent',
        cwd,
        preset: 'scout',
        prompt: `task ${index}`,
        depth: 1,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory.sessions).toHaveLength(1);
    factory.sessions[0].settle();
    await runs[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory.sessions).toHaveLength(2);
    factory.sessions[1].settle();
    await runs[1];
  });

  it('cancels the running child and drops queued ones on abortAll', async () => {
    const { service, factory, cwd } = makeHarness({ manual: true, limits: { maxConcurrent: 1 } });
    const running = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'long task',
      depth: 1,
    });
    const queued = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'queued task',
      depth: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory.sessions).toHaveLength(1);

    service.abortAll('parent', '父会话已结束');
    expect(factory.sessions[0].aborted).toBe(true);
    factory.sessions[0].settle();
    expect((await running).status).toBe('aborted');
    // 排队中的那个不再启动，直接以 aborted 收尾
    expect(factory.sessions).toHaveLength(1);
    expect((await queued).status).toBe('aborted');
    expect(service.runningList()).toEqual([]);
  });

  it('cancels when the tool signal aborts', async () => {
    const { service, factory, cwd } = makeHarness({ manual: true });
    const controller = new AbortController();
    const running = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 1,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(factory.sessions[0].aborted).toBe(true);
    factory.sessions[0].settle();
    const result = await running;
    expect(result.status).toBe('aborted');
  });

  it('abortAllSessions cancels everything (service shutdown)', async () => {
    const { service, factory, cwd } = makeHarness({ manual: true });
    const running = service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.abortAllSessions();
    factory.sessions[0].settle();
    expect((await running).status).toBe('aborted');
  });
});

describe('SubagentService：记录与提示', () => {
  it('keeps recent results per parent session (newest first)', async () => {
    const { service, cwd } = makeHarness();
    await service.run({ parentSessionId: 'parent', cwd, preset: 'scout', prompt: 'a', depth: 1 });
    await service.run({ parentSessionId: 'parent', cwd, preset: 'worker', prompt: 'b', depth: 1 });
    const records = service.listForSession('parent');
    expect(records.map((record) => record.preset)).toEqual(['worker', 'scout']);
    expect(service.listForSession('other')).toEqual([]);
  });

  it('surfaces the model fallback note when the preset model is unusable', async () => {
    const { service, factory, cwd } = makeHarness();
    factory.resolveSubagentModel = vi.fn(async () => ({
      model: { provider: 'deepseek', id: 'deepseek-v4-flash' },
      note: '预设模型「claude-sonnet-4-5」在本机不可用，改用父会话模型',
    }));
    const result = await service.run({
      parentSessionId: 'parent',
      cwd,
      preset: 'scout',
      prompt: 'p',
      depth: 1,
    });
    expect(result.note).toContain('claude-sonnet-4-5');
    expect(result.model).toEqual({ provider: 'deepseek', id: 'deepseek-v4-flash' });
  });

  it('exposes the subagents session directory under the private data dir', () => {
    const root = makeTemp('pi-root-');
    const service = new SubagentService({ agentDir: join(root, '.pi', 'agent') });
    // 本项目私有目录：~/.pi/agent-node-server/subagents（不进共享的 ~/.pi/agent/sessions）
    expect(service.getSessionDir()).toBe(join(root, '.pi', 'agent-node-server', 'subagents'));

    const custom = new SubagentService({
      agentDir: join(root, '.pi', 'agent'),
      sessionDir: join(root, 'custom'),
    });
    expect(custom.getSessionDir()).toBe(join(root, 'custom'));
  });
});

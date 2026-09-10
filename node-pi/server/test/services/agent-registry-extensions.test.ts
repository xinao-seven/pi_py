/**
 * 验证两类"扩展接入"基础设施：
 *
 * 1. `AgentRegistry.register()` 必须派发 `session_start`。
 *    SDK 只在 CLI 的 interactive/print/rpc mode 里调用 `session.bindExtensions()`，
 *    而它正是 `session_start` 的唯一发出点。直接 `createAgentSession()` 不发该事件，
 *    因此依赖它做初始化的内联扩展（PlanModeService 的状态机登记与 JSONL 恢复）
 *    会完全失效——`plan_enable` 会永远返回 409。这里锁死"登记即派发"。
 *
 * 2. `OriginalPiSessionFactory.loader()` 必须过滤掉被内联实现接管的同名文件扩展。
 *    否则 `~/.pi/agent/extensions/plan-mode/` 会与本服务的内联 Plan 状态机并行运行，
 *    形成双状态机 + 工具拦截短路顺序不确定 + 共享会话导致的"隐形规划期"。
 *    过滤只作用于本服务的资源加载，不碰磁盘（CLI 仍照常加载）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  DefaultResourceLoader: vi.fn(),
  ModelRuntime: { create: vi.fn() },
  SessionManager: { listAll: vi.fn(), open: vi.fn() },
  SettingsManager: { create: vi.fn() },
}));

vi.mock('@earendil-works/pi-coding-agent', () => mocks);

import {
  AgentRegistry,
  OriginalPiSessionFactory,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';

/** 可观测 bindExtensions 调用的假会话。 */
class FakeSession implements PiSession {
  readonly sessionId: string;
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'test', id: 'fake' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  bindExtensions = vi.fn(async () => undefined);

  constructor(sessionId = 'session-start-test') {
    this.sessionId = sessionId;
  }

  getActiveToolNames(): string[] {
    return [];
  }
  subscribe(): () => void {
    return () => undefined;
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

class FakeFactory implements PiSessionFactory {
  constructor(readonly session: PiSession) {}
  async create(): Promise<PiSession> {
    return this.session;
  }
}

describe('AgentRegistry 派发 session_start', () => {
  it('create() 登记后调用 bindExtensions，使依赖该钩子的扩展能初始化', async () => {
    const session = new FakeSession();
    const registry = new AgentRegistry(new FakeFactory(session));

    await registry.create({ cwd: '/tmp/ws' });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    // 传空对象：仅触发事件，不额外绑定 UI / mode（Node 后端没有 TUI）。
    expect(session.bindExtensions).toHaveBeenCalledWith({});
  });

  it('bindExtensions 抛错不阻断会话登记（扩展是增量能力）', async () => {
    const session = new FakeSession();
    session.bindExtensions = vi.fn(async () => {
      throw new Error('extension exploded');
    });
    const warnings: unknown[] = [];
    const registry = new AgentRegistry(new FakeFactory(session), undefined, undefined, {
      info: () => undefined,
      warn: (payload: unknown) => warnings.push(payload),
      error: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      fatal: () => undefined,
      child: () => undefined,
    } as never);

    const entry = await registry.create({ cwd: '/tmp/ws' });

    expect(entry.session.sessionId).toBe('session-start-test');
    expect(registry.get('session-start-test')).toBeDefined();
    expect(warnings).toHaveLength(1);
    // 日志只记消息，不落堆栈/敏感信息。
    expect(JSON.stringify(warnings[0])).toContain('extension exploded');
  });

  it('从磁盘恢复的会话同样派发 session_start', async () => {
    const session = new FakeSession('restored-session');
    const factory: PiSessionFactory = {
      create: async () => session,
      listPersistedSessions: async () => [
        {
          id: 'restored-session',
          path: '/tmp/sessions/restored.jsonl',
          cwd: '/tmp/ws',
          name: undefined,
          parentSessionPath: undefined,
          created: new Date(0),
          modified: new Date(0),
          messageCount: 0,
          firstMessage: '',
        },
      ],
      open: async () => session,
    };
    const registry = new AgentRegistry(factory);

    await registry.open('restored-session');

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
  });
});

describe('OriginalPiSessionFactory 过滤被内联接管的文件扩展', () => {
  let loaderOptions: Record<string, unknown> | undefined;

  function extension(path: string) {
    return { path, handlers: new Map(), tools: new Map(), commands: new Map() };
  }

  function applyOverride(extensions: unknown[]) {
    const override = loaderOptions?.extensionsOverride as
      ((base: unknown) => { extensions: unknown[] }) | undefined;
    expect(override).toBeTypeOf('function');
    return override!({ extensions, errors: [], runtime: {} }).extensions;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loaderOptions = undefined;
    mocks.DefaultResourceLoader.mockImplementation(function (
      this: unknown,
      options: Record<string, unknown>,
    ) {
      loaderOptions = options;
      return { reload: vi.fn().mockResolvedValue(undefined) };
    });
    mocks.createAgentSession.mockResolvedValue({ session: new FakeSession() });
  });

  it('过滤用户级与工作区级的 subagent（M5 接管同名工具），保留其他扩展', async () => {
    const factory = new OriginalPiSessionFactory('/home/u/.pi/agent');
    await factory.create({ cwd: '/tmp/ws' });
    const kept = applyOverride([
      extension('/home/u/.pi/agent/extensions/subagent/index.ts'),
      extension('/tmp/ws/.pi/extensions/other/index.ts'),
    ]);
    expect(kept).toHaveLength(1);
    expect((kept[0] as { path: string }).path).toContain('other');
  });

  it('过滤用户级与工作区级的 plan-mode，保留其他扩展', async () => {
    const factory = new OriginalPiSessionFactory('/home/u/.pi/agent');
    await factory.create({ cwd: '/tmp/ws' });

    const kept = applyOverride([
      extension('/home/u/.pi/agent/extensions/plan-mode/index.ts'),
      extension('/tmp/ws/.pi/extensions/plan-mode/index.ts'),
      extension('/home/u/.pi/agent/extensions/my-helper/index.ts'),
      extension('<inline:1>'),
    ]);

    // 两个 plan-mode（用户级 + 工作区级）都被过滤；其他扩展原样保留。
    expect(kept.map((item) => (item as { path: string }).path)).toEqual([
      '/home/u/.pi/agent/extensions/my-helper/index.ts',
      '<inline:1>',
    ]);
  });

  it('Windows 路径分隔符同样识别', async () => {
    const factory = new OriginalPiSessionFactory('C:\\Users\\u\\.pi\\agent');
    await factory.create({ cwd: 'C:\\ws' });

    const kept = applyOverride([
      extension('C:\\Users\\u\\.pi\\agent\\extensions\\plan-mode\\index.ts'),
      extension('C:\\Users\\u\\.pi\\agent\\extensions\\other\\index.ts'),
    ]);

    expect(kept).toHaveLength(1);
    expect((kept[0] as { path: string }).path).toContain('other');
  });

  it('名字相似但不属于该目录的扩展不受影响', async () => {
    const factory = new OriginalPiSessionFactory('/home/u/.pi/agent');
    await factory.create({ cwd: '/tmp/ws' });

    const kept = applyOverride([
      extension('/home/u/.pi/agent/extensions/plan-mode-extra/index.ts'),
      extension('/home/u/.pi/agent/agents/plan-mode/index.ts'),
    ]);

    expect(kept).toHaveLength(2);
  });

  it('被过滤时写一条 info 日志，带上 cwd 与被过滤路径', async () => {
    const infos: unknown[] = [];
    const factory = new OriginalPiSessionFactory(
      '/home/u/.pi/agent',
      undefined,
      undefined,
      undefined,
      {
        info: (payload: unknown) => infos.push(payload),
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        fatal: () => undefined,
        child: () => undefined,
      } as never,
    );
    await factory.create({ cwd: '/tmp/ws' });
    applyOverride([extension('/home/u/.pi/agent/extensions/plan-mode/index.ts')]);

    expect(infos).toHaveLength(1);
    // M5 起 subagent 也被内联实现接管（工具名同名，避免两套并存）
    expect(infos[0]).toMatchObject({ cwd: '/tmp/ws', ownedBy: ['plan-mode', 'subagent'] });
  });
});

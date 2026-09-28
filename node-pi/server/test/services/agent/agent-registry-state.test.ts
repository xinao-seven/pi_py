import { describe, expect, it } from 'vitest';

import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
  withInlineTools,
} from '../../../src/services/agent/agent-registry.js';
import { ApiError } from '../../../src/errors.js';

/** 带 SDK 指标的假会话：只实现 state() 需要用到的那部分能力。 */
function sessionWithStats(options: { stats?: boolean; usage?: boolean }): PiSession {
  const base = {
    sessionId: 'session-stats',
    isStreaming: false,
    thinkingLevel: 'medium',
    model: { provider: 'deepseek', id: 'deepseek-chat' },
    messages: [],
    isCompacting: false,
    retryAttempt: 0,
    modelRuntime: { getModel: (provider: string, id: string) => ({ provider, id }) },
    getActiveToolNames: () => ['bash'],
    subscribe: () => () => undefined,
    prompt: async () => undefined,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    setActiveToolsByName: () => undefined,
    compact: async () => undefined,
    navigateTree: async () => undefined,
    reload: async () => undefined,
    dispose: () => undefined,
  };
  return {
    ...base,
    ...(options.stats
      ? {
          getSessionStats: () => ({
            sessionId: 'session-stats',
            toolCalls: 3,
            tokens: { input: 1_500, output: 250, cacheRead: 0, cacheWrite: 0, total: 1_750 },
            cost: 0.0123,
          }),
        }
      : {}),
    ...(options.usage
      ? {
          getContextUsage: () => ({ tokens: 12_345, contextWindow: 128_000, percent: 9.6 }),
        }
      : {}),
  } as unknown as PiSession;
}

function registryFor(session: PiSession): AgentRegistry {
  const factory: PiSessionFactory = { create: async () => session };
  return new AgentRegistry(factory);
}

describe('AgentRegistry.state() facade metrics', () => {
  it('passes through the SDK session stats and context usage', async () => {
    const registry = registryFor(sessionWithStats({ stats: true, usage: true }));
    await registry.create({ cwd: '/workspace' });

    expect(registry.state('session-stats')).toMatchObject({
      contextUsage: { tokens: 12_345, contextWindow: 128_000, percent: 9.6 },
      sessionStats: { toolCalls: 3, cost: 0.0123 },
    });
  });

  it('keeps the Python-compatible null/{} shape when the session lacks the APIs', async () => {
    const registry = registryFor(sessionWithStats({}));
    await registry.create({ cwd: '/workspace' });

    expect(registry.state('session-stats')).toMatchObject({ contextUsage: null, sessionStats: {} });
  });

  it('keeps null when the SDK reports unknown usage (right after compaction)', async () => {
    const session = sessionWithStats({ usage: true });
    (session as unknown as { getContextUsage: () => unknown }).getContextUsage = () => undefined;
    const registry = registryFor(session);
    await registry.create({ cwd: '/workspace' });

    expect(registry.state('session-stats')).toMatchObject({ contextUsage: null });
  });
});

describe('AgentRegistry.promptSnapshot()（会话信息面板的后端）', () => {
  /** 带「发给模型的东西」的假会话：形状对齐 SDK（systemPrompt/resourceLoader 是属性）。 */
  function sessionWithPromptSources(): PiSession {
    const base = sessionWithStats({}) as unknown as Record<string, unknown>;
    return {
      ...base,
      getActiveToolNames: () => ['read'],
      systemPrompt: 'You are pi.',
      getAllTools: () => [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'mcp__github__list_issues', sourceInfo: { source: 'inline' } },
      ],
      resourceLoader: {
        getSkills: () => ({ skills: [{ name: 'tavily-search', description: 'search' }] }),
      },
    } as unknown as PiSession;
  }

  it('passes the session sources plus the entry context into the snapshot', async () => {
    const registry = registryFor(sessionWithPromptSources());
    await registry.create({ cwd: '/workspace' });

    const snapshot = registry.promptSnapshot('session-stats');

    expect(snapshot).toMatchObject({
      sessionId: 'session-stats',
      cwd: '/workspace',
      model: { provider: 'deepseek', modelId: 'deepseek-chat' },
      thinkingLevel: 'medium',
      systemPrompt: { text: 'You are pi.' },
      overview: { toolsRegistered: 2, toolsActive: 1, mcpTools: 1, skills: 1 },
    });
    // 激活标记来自会话自己的 `getActiveToolNames()`，注册表只透传。
    expect(snapshot.tools.map((tool) => [tool.name, tool.active])).toEqual([
      ['read', true],
      ['mcp__github__list_issues', false],
    ]);
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(['tavily-search']);
  });

  it('uses the factory MCP resolver when it is available', async () => {
    const session = sessionWithPromptSources();
    const factory: PiSessionFactory = {
      create: async () => session,
      resolveMcpTool: () => ({ server: 'github-enterprise', tool: 'issues.list' }),
    };
    const registry = new AgentRegistry(factory);
    await registry.create({ cwd: '/workspace' });

    const snapshot = registry.promptSnapshot('session-stats');
    expect(snapshot.tools.find((tool) => tool.source === 'mcp')?.mcp).toEqual({
      server: 'github-enterprise',
      tool: 'issues.list',
    });
  });

  it('throws for an inactive session instead of inventing one', async () => {
    const registry = registryFor(sessionWithPromptSources());
    await registry.create({ cwd: '/workspace' });

    expect(() => registry.promptSnapshot('missing')).toThrow(ApiError);
    expect(() => registry.promptSnapshot('missing')).toThrow(/not active/i);
  });
});

describe('withInlineTools（M4：预设白名单必须并入内联扩展的工具）', () => {
  it('appends inline tools and de-duplicates', () => {
    expect(withInlineTools(['read', 'bash'], ['submit_plan', 'read'])).toEqual([
      'read',
      'bash',
      'submit_plan',
    ]);
  });

  it('keeps the SDK default (undefined) when no preset tool list was given', () => {
    expect(withInlineTools(undefined, ['submit_plan'])).toBeUndefined();
  });

  it('works when the preset list is empty (still needs the inline tools)', () => {
    expect(withInlineTools([], ['submit_plan'])).toEqual(['submit_plan']);
  });
});

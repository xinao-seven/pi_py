import { describe, expect, it } from 'vitest';

import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
  withInlineTools,
} from '../../src/services/agent-registry.js';

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

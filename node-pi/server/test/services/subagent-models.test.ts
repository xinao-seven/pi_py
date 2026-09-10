import { describe, expect, it } from 'vitest';

import { resolveSubagentModel, type ModelCatalog } from '../../src/services/subagent-models.js';

const PARENT = { provider: 'deepseek', id: 'deepseek-v4-flash' };

/** 一个假目录：只有 deepseek 配了凭据（还原本机现状）。 */
function catalog(options: { models: Array<[string, string]>; authed: string[] }): ModelCatalog {
  return {
    getModel: (provider, id) =>
      options.models.some(([p, m]) => p === provider && m === id) ? { provider, id } : undefined,
    getModels: () => options.models.map(([provider, id]) => ({ provider, id })),
    hasConfiguredAuth: (provider) => options.authed.includes(provider),
  };
}

const DEEPSEEK_ONLY = catalog({
  models: [
    ['deepseek', 'deepseek-v4-flash'],
    ['deepseek', 'deepseek-v4-pro'],
    ['anthropic', 'claude-sonnet-4-5'],
    ['opencode', 'claude-sonnet-4-5'],
  ],
  authed: ['deepseek'],
});

describe('子会话模型解析', () => {
  it('inherits the parent model when no spec is given', () => {
    expect(resolveSubagentModel({ fallback: PARENT, catalog: DEEPSEEK_ONLY })).toEqual({
      model: PARENT,
    });
    expect(resolveSubagentModel({ spec: 'inherit', fallback: PARENT })).toEqual({ model: PARENT });
    expect(resolveSubagentModel({ spec: '   ', fallback: PARENT })).toEqual({ model: PARENT });
  });

  it('resolves provider/model when that provider is authenticated', () => {
    expect(
      resolveSubagentModel({
        spec: 'deepseek/deepseek-v4-pro',
        fallback: PARENT,
        catalog: DEEPSEEK_ONLY,
      }),
    ).toEqual({ model: { provider: 'deepseek', id: 'deepseek-v4-pro' } });
  });

  it('falls back to the parent model when the provider is not authenticated', () => {
    // 这正是官方 subagent 扩展在本机失败的原因：预设写死 claude-*，而只鉴权了 deepseek。
    const resolved = resolveSubagentModel({
      spec: 'anthropic/claude-sonnet-4-5',
      fallback: PARENT,
      catalog: DEEPSEEK_ONLY,
    });
    expect(resolved.model).toEqual(PARENT);
    expect(resolved.note).toContain('claude-sonnet-4-5');
    expect(resolved.note).toContain('父会话模型');
  });

  it('resolves a bare id when it uniquely matches an authenticated provider', () => {
    const only = catalog({
      models: [
        ['zai', 'glm-4.6'],
        ['openai', 'gpt-5'],
      ],
      authed: ['zai'],
    });
    expect(resolveSubagentModel({ spec: 'glm-4.6', fallback: PARENT, catalog: only })).toEqual({
      model: { provider: 'zai', id: 'glm-4.6' },
    });
  });

  it('falls back when a bare id is ambiguous across authenticated providers', () => {
    const ambiguous = catalog({
      models: [
        ['anthropic', 'claude-sonnet-4-5'],
        ['opencode', 'claude-sonnet-4-5'],
      ],
      authed: ['anthropic', 'opencode'],
    });
    const resolved = resolveSubagentModel({
      spec: 'claude-sonnet-4-5',
      fallback: PARENT,
      catalog: ambiguous,
    });
    expect(resolved.model).toEqual(PARENT);
    expect(resolved.note).toContain('同名');
  });

  it('falls back when the model does not exist at all', () => {
    const resolved = resolveSubagentModel({
      spec: 'no-such-model',
      fallback: PARENT,
      catalog: DEEPSEEK_ONLY,
    });
    expect(resolved.model).toEqual(PARENT);
    expect(resolved.note).toContain('不可用');
  });

  it('keeps the parent model when there is no catalog to check against', () => {
    const resolved = resolveSubagentModel({ spec: 'whatever', fallback: PARENT });
    expect(resolved.model).toEqual(PARENT);
    expect(resolved.note).toContain('无法校验');
  });

  it('reports no model when neither spec nor parent model is available', () => {
    const resolved = resolveSubagentModel({ spec: 'anthropic/claude-sonnet-4-5' });
    expect(resolved.model).toBeUndefined();
    expect(resolved.note).toBeTruthy();
  });
});

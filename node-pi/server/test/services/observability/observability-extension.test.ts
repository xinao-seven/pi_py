import { describe, expect, it } from 'vitest';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  buildObservabilityExtension,
  type RuntimeObserver,
} from '../../../src/services/observability/observability-extension.js';

/** 捕获扩展注册的钩子（与其它扩展测试同样的做法）。 */
function makeFakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  return {
    handlers,
    on(channel: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(channel, handler);
    },
  };
}

function makeObserver() {
  const calls: Array<[string, unknown]> = [];
  const observer: RuntimeObserver = {
    noteProviderRequestStart: (sessionId) => calls.push(['requestStart', sessionId]),
    noteProviderResponse: (sessionId, status) => calls.push(['response', [sessionId, status]]),
    noteProviderPayload: (sessionId, payload) => calls.push(['payload', [sessionId, payload]]),
    noteContextMessages: (sessionId, messages) => calls.push(['context', [sessionId, messages]]),
    noteModelSelect: (input) => calls.push(['modelSelect', input]),
  };
  return { observer, calls };
}

function register() {
  const { observer, calls } = makeObserver();
  const pi = makeFakePi();
  buildObservabilityExtension(observer)(pi as unknown as ExtensionAPI);
  return { pi, calls };
}

const ctx = (sessionId = 'session-1') => ({ sessionManager: { getSessionId: () => sessionId } });

describe('buildObservabilityExtension', () => {
  it('registers every observation hook it promises', () => {
    const { pi } = register();

    expect([...pi.handlers.keys()].sort()).toEqual([
      'after_provider_response',
      'before_provider_headers',
      'before_provider_request',
      'context',
      'model_select',
    ]);
  });

  it('forwards provider HTTP points with the session id', () => {
    const { pi, calls } = register();

    pi.handlers.get('before_provider_headers')?.({ type: 'before_provider_headers' }, ctx());
    pi.handlers.get('after_provider_response')?.({ status: 200 }, ctx());

    expect(calls).toEqual([
      ['requestStart', 'session-1'],
      ['response', ['session-1', 200]],
    ]);
  });

  it('forwards the raw request payload and the context messages', () => {
    const { pi, calls } = register();
    const payload = { messages: [], tools: [] };
    const messages = [{ customType: 'task-resume', content: 'x' }];

    pi.handlers.get('before_provider_request')?.({ payload }, ctx());
    pi.handlers.get('context')?.({ messages }, ctx());

    expect(calls).toEqual([
      ['payload', ['session-1', payload]],
      ['context', ['session-1', messages]],
    ]);
  });

  it('normalizes the model_select event into ids plus the source', () => {
    const { pi, calls } = register();

    pi.handlers.get('model_select')?.(
      { model: { id: 'deepseek-v4-pro' }, previousModel: { id: 'deepseek-chat' }, source: 'set' },
      ctx(),
    );
    // 没有 previousModel（首次选择）时不应生成 `previousModel: undefined`。
    pi.handlers.get('model_select')?.({ model: { name: 'gpt-x' }, source: 'restore' }, ctx());

    expect(calls[0][1]).toEqual({
      sessionId: 'session-1',
      model: 'deepseek-v4-pro',
      previousModel: 'deepseek-chat',
      source: 'set',
    });
    expect(calls[1][1]).toEqual({ sessionId: 'session-1', model: 'gpt-x', source: 'restore' });
  });

  it('skips hooks when the session id cannot be resolved, and never throws', () => {
    const { pi, calls } = register();
    const brokenCtx = {
      sessionManager: {
        getSessionId: () => {
          throw new Error('no session');
        },
      },
    };

    expect(() => pi.handlers.get('before_provider_headers')?.({}, brokenCtx)).not.toThrow();
    expect(pi.handlers.get('before_provider_headers')?.({}, {})).toBeUndefined();
    expect(
      pi.handlers.get('after_provider_response')?.({ status: 500 }, undefined),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

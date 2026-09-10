import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';

/** 造一条 count 层深的会话树（迭代构造，模拟"一条消息一个节点"的长会话）。 */
function deepTree(count: number): unknown[] {
  let child: Record<string, unknown> | null = null;
  for (let index = count - 1; index >= 0; index -= 1) {
    child = {
      entry: {
        type: 'message',
        id: `n${index}`,
        parentId: index === 0 ? null : `n${index - 1}`,
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `第 ${index} 条` },
      },
      children: child === null ? [] : [child],
    };
  }
  return [child!];
}

const LONG_SESSION_ENTRIES = 3000;

/** 带分支树的假会话：让路由拿到一棵真实形状（深嵌套）的树。 */
class FakeSessionWithTree implements PiSession {
  readonly sessionId = 'long-session';
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'test', id: 'fake' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  readonly sessionManager = {
    getSessionFile: () => undefined,
    getSessionId: () => this.sessionId,
    getLeafId: () => `n${LONG_SESSION_ENTRIES - 1}`,
    getTree: () => deepTree(LONG_SESSION_ENTRIES),
    buildContextEntries: () => [],
    buildSessionContext: () => ({ messages: [], thinkingLevel: 'medium', model: null }),
  };

  getActiveToolNames(): string[] {
    return ['read'];
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

class FakeSessionFactory implements PiSessionFactory {
  readonly session = new FakeSessionWithTree();
  async create(): Promise<PiSession> {
    return this.session;
  }
}

describe('GET /api/sessions/:sessionId', () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('长会话返回扁平树而不是嵌套树（回归：曾 RangeError 500）', async () => {
    const registry = new AgentRegistry(new FakeSessionFactory());
    const app = createApp({ registry });
    apps.push(app);

    await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      payload: { cwd: process.cwd(), message: 'hello' },
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/long-session' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { tree: Array<{ id: string; depth: number; role: string }> };
    expect(body.tree).toHaveLength(LONG_SESSION_ENTRIES);
    expect(body.tree[0]).toMatchObject({ id: 'n0', depth: 0, type: 'message', role: 'user' });
    expect(body.tree.at(-1)).toMatchObject({ id: `n${LONG_SESSION_ENTRIES - 1}` });
    expect(body.tree.at(-1)?.depth).toBe(LONG_SESSION_ENTRIES - 1);
    // 节点里不再有 children（嵌套结构才是爆栈根因）
    expect(body.tree[0]).not.toHaveProperty('children');
  });
});

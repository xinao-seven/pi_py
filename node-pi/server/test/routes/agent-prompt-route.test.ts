import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../../src/app.js';
import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';

const apps: ReturnType<typeof createApp>[] = [];
const tempDirs: string[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-session-prompt-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** 假会话：只要提供 systemPrompt / getAllTools / resourceLoader，面板就有内容。 */
class FakeSession implements PiSession {
  readonly sessionId = 'session-1';
  isStreaming = false;
  thinkingLevel = 'medium';
  model = { provider: 'deepseek', id: 'deepseek-chat' };
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
  systemPrompt = 'You are pi. Follow the guidelines.';
  resourceLoader = {
    getSkills: () => ({
      skills: [
        { name: 'tavily-search', description: 'Web search', filePath: '/skills/t/SKILL.md' },
      ],
    }),
    getPrompts: () => ({ prompts: [{ name: 'review', description: 'Review a diff' }] }),
    getAgentsFiles: () => ({ agentsFiles: [{ path: '/ws/CLAUDE.md', content: 'guide' }] }),
  };

  getActiveToolNames(): string[] {
    return ['read', 'bash'];
  }
  getAllTools(): Array<Record<string, unknown>> {
    return [
      {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: {} }, required: ['path'] },
        sourceInfo: { path: '<builtin:read>', source: 'builtin' },
      },
      {
        name: 'mcp__github__list_issues',
        description: 'List issues',
        sourceInfo: { path: '<inline>', source: 'inline' },
      },
    ];
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

const factory: PiSessionFactory = {
  create: async () => new FakeSession(),
  resolveMcpTool: () => ({ server: 'github-enterprise', tool: 'issues.list' }),
};

describe('GET /api/agent/:sessionId/prompt', () => {
  it('returns the prompt snapshot for the active session', async () => {
    const cwd = tempWorkspace();
    const registry = new AgentRegistry(factory);
    const app = createApp({ registry });
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/agent/new',
      // message 必填（/new 会下一道 prompt 命令）；假会话的 prompt() 是空实现。
      payload: { cwd, message: 'hi' },
    });
    // 长任务以 202 接收（结果走 SSE），这正是本项目对外的约定。
    expect(created.statusCode).toBe(202);
    const sessionId = created.json().sessionId as string;

    const response = await app.inject({ method: 'GET', url: `/api/agent/${sessionId}/prompt` });
    expect(response.statusCode).toBe(200);
    const { snapshot } = response.json();

    expect(snapshot).toMatchObject({
      sessionId,
      cwd,
      model: { provider: 'deepseek', modelId: 'deepseek-chat' },
      thinkingLevel: 'medium',
      systemPrompt: { text: 'You are pi. Follow the guidelines.' },
      overview: {
        toolsRegistered: 2,
        // read/bash 里只有 read 注册在工具表里，bash 只是「激活但没定义」——不虚报。
        toolsActive: 1,
        mcpTools: 1,
        skills: 1,
        promptTemplates: 1,
        contextFiles: 1,
      },
    });
    // MCP 归属走工厂的解析器（toolIndex 优先于名字拆解）。
    expect(snapshot.tools.find((tool: { source: string }) => tool.source === 'mcp').mcp).toEqual({
      server: 'github-enterprise',
      tool: 'issues.list',
    });
    expect(snapshot.skills[0]).toMatchObject({ name: 'tavily-search' });
    expect(snapshot.contextFiles).toEqual([{ path: '/ws/CLAUDE.md', chars: 5 }]);

    await registry.close();
  });

  it('answers 404 for a session that does not exist', async () => {
    const app = createApp({ registry: new AgentRegistry(factory) });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/agent/does-not-exist/prompt' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('session_not_found');
  });
});

/**
 * /api/mcp/* 路由集成测试：验证嵌套 server 配置的 REST 形状、试连与启停。
 * 使用真实 McpService（临时 agentDir + 本地 stdio fixture），会话注册表用假工厂避免真实 Pi 会话。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  AgentRegistry,
  type PiSession,
  type PiSessionFactory,
} from '../../src/services/agent-registry.js';
import { McpConfig } from '../../src/services/mcp/mcp-config.js';
import { McpService } from '../../src/services/mcp/mcp-service.js';

const fixturePath = fileURLToPath(new URL('../fixtures/mcp-test-server.mjs', import.meta.url));

class StubPiSession implements PiSession {
  readonly sessionId = 'stub';
  isStreaming = false;
  thinkingLevel = 'medium';
  model = undefined;
  messages: unknown[] = [];
  isCompacting = false;
  retryAttempt = 0;
  modelRuntime = { getModel: (provider: string, id: string) => ({ provider, id }) };
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

class StubPiSessionFactory implements PiSessionFactory {
  async create(): Promise<PiSession> {
    return new StubPiSession();
  }
}

let tempDirs: string[] = [];
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('/api/mcp routes', () => {
  it('嵌套 server 配置：新增 → 列表(connected) → 试连 → 启停 → 删除', async () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    const mcpService = new McpService(new McpConfig(agentDir));
    const registry = new AgentRegistry(new StubPiSessionFactory());
    const app = createApp({ agentDir, registry, mcpService });
    try {
      await app.ready();

      // 新增（嵌套 server 键）
      let response = await app.inject({
        method: 'POST',
        url: '/api/mcp/servers',
        payload: {
          name: 'test-server',
          cwd,
          scope: 'workspace',
          server: { transport: 'stdio', command: process.execPath, args: [fixturePath] },
        },
      });
      expect(response.statusCode).toBe(200);

      // 列表：connected + 3 工具
      response = await app.inject({
        method: 'GET',
        url: `/api/mcp/servers?cwd=${encodeURIComponent(cwd)}`,
      });
      expect(response.statusCode).toBe(200);
      const servers = response.json().servers;
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: 'test-server',
        scope: 'workspace',
        status: 'connected',
        toolCount: 3,
      });

      // 试连（已保存配置）
      response = await app.inject({
        method: 'POST',
        url: '/api/mcp/servers/test-server/test',
        payload: { cwd },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true, toolCount: 3 });

      // 试连（未保存的表单配置）
      response = await app.inject({
        method: 'POST',
        url: '/api/mcp/servers/draft/test',
        payload: {
          cwd,
          server: { transport: 'stdio', command: process.execPath, args: [fixturePath] },
        },
      });
      expect(response.json()).toMatchObject({ success: true, toolCount: 3 });

      // 启停：PATCH enabled=false → disabled
      response = await app.inject({
        method: 'PATCH',
        url: '/api/mcp/servers/test-server',
        payload: {
          cwd,
          scope: 'workspace',
          server: {
            transport: 'stdio',
            command: process.execPath,
            args: [fixturePath],
            enabled: false,
          },
        },
      });
      expect(response.statusCode).toBe(200);
      response = await app.inject({
        method: 'GET',
        url: `/api/mcp/servers?cwd=${encodeURIComponent(cwd)}`,
      });
      expect(response.json().servers[0]).toMatchObject({ enabled: false, status: 'disabled' });

      // 删除
      response = await app.inject({
        method: 'DELETE',
        url: `/api/mcp/servers/test-server?cwd=${encodeURIComponent(cwd)}&scope=workspace`,
      });
      expect(response.statusCode).toBe(200);
      response = await app.inject({
        method: 'GET',
        url: `/api/mcp/servers?cwd=${encodeURIComponent(cwd)}`,
      });
      expect(response.json().servers).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('拒绝非法配置（缺 command / 坏 URL）', async () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    const mcpService = new McpService(new McpConfig(agentDir));
    const registry = new AgentRegistry(new StubPiSessionFactory());
    const app = createApp({ agentDir, registry, mcpService });
    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/api/mcp/servers',
        payload: { name: 'bad', cwd, server: { transport: 'stdio' } },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    } finally {
      await app.close();
    }
  });
});

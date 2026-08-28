/**
 * McpService 集成测试：用本地 stdio MCP server（test/fixtures/mcp-test-server.mjs）
 * 验证连接、工具注册、工具调用、失败处理、审批联动与状态上报。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { ToolApprovalBroker } from '../../src/services/tool-approval.js';
import { McpConfig } from '../../src/services/mcp/mcp-config.js';
import { buildMcpExtension } from '../../src/services/mcp/mcp-extension.js';
import { McpService } from '../../src/services/mcp/mcp-service.js';

const fixturePath = fileURLToPath(new URL('../fixtures/mcp-test-server.mjs', import.meta.url));

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

describe('McpService（stdio 集成）', () => {
  it('连接 server、注册工具、调用成功/失败工具', async () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    const config = new McpConfig(agentDir);
    config.upsert(cwd, 'user', 'test-server', {
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      enabled: true,
    });
    const service = new McpService(config);
    try {
      await service.ensure(cwd);
      const tools = service.toolsFor(cwd);
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('mcp__test_server__echo');
      expect(names).toContain('mcp__test_server__add');
      expect(names).toContain('mcp__test_server__fail');

      // 工具定义可直接执行（走 execute → service.callTool）
      const echo = tools.find((tool) => tool.name === 'mcp__test_server__echo')!;
      // promptSnippet 让工具出现在系统提示词的 Available tools 区
      expect(echo.promptSnippet).toContain('MCP server: test-server');
      const result = await echo.execute(
        'call-1',
        { text: 'hello' },
        undefined,
        undefined,
        undefined as never,
      );
      expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);

      // 数值参数（TypeBox number 校验通过）
      const add = tools.find((tool) => tool.name === 'mcp__test_server__add')!;
      const sum = await add.execute(
        'call-2',
        { a: 2, b: 3 },
        undefined,
        undefined,
        undefined as never,
      );
      expect((sum.content[0] as { text: string }).text).toBe('5');

      // isError → 抛错（与 bash 工具的失败惯例一致）
      const fail = tools.find((tool) => tool.name === 'mcp__test_server__fail')!;
      await expect(
        fail.execute('call-3', {}, undefined, undefined, undefined as never),
      ).rejects.toThrow(/boom/);
    } finally {
      await service.dispose();
    }
  });

  it('状态上报 connected 与工具清单', async () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    const config = new McpConfig(agentDir);
    config.upsert(cwd, 'user', 'test-server', {
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
    });
    const service = new McpService(config);
    try {
      const views = await service.listServers(cwd);
      expect(views).toHaveLength(1);
      expect(views[0].name).toBe('test-server');
      expect(views[0].status).toBe('connected');
      expect(views[0].toolCount).toBe(3);
      expect(views[0].tools.map((tool) => tool.name)).toEqual(['echo', 'add', 'fail']);
    } finally {
      await service.dispose();
    }
  });

  it('删除配置后断开连接（sync 对账）', async () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    const config = new McpConfig(agentDir);
    config.upsert(cwd, 'user', 'test-server', {
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
    });
    const service = new McpService(config);
    try {
      await service.ensure(cwd);
      expect(service.toolsFor(cwd)).toHaveLength(3);

      config.remove(cwd, 'user', 'test-server');
      await service.ensure(cwd);
      expect(service.toolsFor(cwd)).toHaveLength(0);
      // 已断开：调用应抛 503
      await expect(
        service.callTool(cwd, 'mcp__test_server__echo', { text: 'x' }),
      ).rejects.toMatchObject({ code: 'mcp_not_connected' });
    } finally {
      await service.dispose();
    }
  });
});

describe('MCP 内联扩展（审批联动）', () => {
  it('approval: required 的 server 工具走事件总线审批', async () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    const config = new McpConfig(agentDir);
    config.upsert(cwd, 'user', 'test-server', {
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      approval: 'required',
    });
    const service = new McpService(config);

    const broker = new ToolApprovalBroker();
    const registered: string[] = [];
    const fakePi = {
      handlers: new Map<string, (event: unknown, ctx: unknown) => unknown>(),
      registerTool(tool: { name: string }) {
        registered.push(tool.name);
      },
      on(channel: string, handler: (event: unknown, ctx: unknown) => unknown) {
        this.handlers.set(channel, handler);
      },
      async runToolCall(event: unknown, ctx: unknown) {
        const handler = this.handlers.get('tool_call');
        if (!handler) throw new Error('no tool_call handler');
        return handler(event, ctx);
      },
    };
    try {
      const factory = buildMcpExtension(service, cwd, broker);
      await (factory as (pi: typeof fakePi) => Promise<void>)(fakePi as never);

      expect(registered).toContain('mcp__test_server__echo');

      const ctx = {
        hasUI: false,
        sessionManager: { getSessionId: () => 'session-1' },
        signal: undefined as AbortSignal | undefined,
      };
      const pending = fakePi.runToolCall(
        { toolName: 'mcp__test_server__echo', toolCallId: 'call-1', input: { text: 'hi' } },
        ctx,
      );
      // 等待 pending 已登记（同步 emit，加一次微任务保险）
      await new Promise((resolve) => setImmediate(resolve));
      broker.decide('session-1', 'call-1', true);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      broker.dispose();
      await service.dispose();
    }
  });

  it('未配置 approval 的 server 工具直接放行', async () => {
    const agentDir = makeTemp('pi-agent-');
    const cwd = makeTemp('pi-cwd-');
    const config = new McpConfig(agentDir);
    config.upsert(cwd, 'user', 'test-server', {
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
    });
    const service = new McpService(config);
    const fakePi = {
      handlers: new Map<string, (event: unknown, ctx: unknown) => unknown>(),
      registerTool() {},
      on(channel: string, handler: (event: unknown, ctx: unknown) => unknown) {
        this.handlers.set(channel, handler);
      },
      async runToolCall(event: unknown, ctx: unknown) {
        const handler = this.handlers.get('tool_call');
        return handler ? handler(event, ctx) : undefined;
      },
    };
    try {
      const factory = buildMcpExtension(service, cwd);
      await (factory as (pi: typeof fakePi) => Promise<void>)(fakePi as never);
      const ctx = {
        hasUI: false,
        sessionManager: { getSessionId: () => 'session-1' },
        signal: undefined as AbortSignal | undefined,
      };
      const result = await fakePi.runToolCall(
        { toolName: 'mcp__test_server__echo', toolCallId: 'call-1', input: { text: 'hi' } },
        ctx,
      );
      expect(result).toBeUndefined();
      // 非 MCP 工具不拦截
      const bash = await fakePi.runToolCall(
        { toolName: 'bash', toolCallId: 'call-2', input: { command: 'ls' } },
        ctx,
      );
      expect(bash).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });
});

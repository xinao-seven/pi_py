/**
 * 验证 OriginalPiSessionFactory 把预设的 systemPrompt / compaction / 工具 / 思考等级
 * 正确透传给 createAgentSession。mock 掉 SDK，捕获 createAgentSession 的 options。
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

import { OriginalPiSessionFactory } from '../../src/services/agent-registry.js';
import { PlanModeService } from '../../src/services/plan-mode-service.js';
import { ToolApprovalBroker } from '../../src/services/tool-approval.js';

describe('OriginalPiSessionFactory', () => {
  const agentDir = '/tmp/fake-pi-agent';
  let loaderOptions: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    loaderOptions = undefined;
    // 用普通函数表达式实现，才能被 `new DefaultResourceLoader(...)` 调用（箭头函数不可构造）。
    mocks.DefaultResourceLoader.mockImplementation(function (
      this: unknown,
      options: Record<string, unknown>,
    ) {
      loaderOptions = options;
      return { reload: vi.fn().mockResolvedValue(undefined) };
    });
    mocks.ModelRuntime.create.mockResolvedValue({
      getModel: (provider: string, modelId: string) => ({ provider, modelId }),
    });
    mocks.createAgentSession.mockResolvedValue({ session: { sessionId: 'node-factory-test' } });
  });

  it('threads systemPrompt, compaction, tools and thinking level into createAgentSession', async () => {
    const applyOverrides = vi.fn();
    mocks.SettingsManager.create.mockReturnValue({ applyOverrides });
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({
      cwd: '/tmp/workspace',
      systemPrompt: 'custom prompt',
      compaction: { enabled: false, keepRecentTokens: 8000, reserveTokens: 16384 },
      toolNames: [],
      thinkingLevel: 'off',
    });

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(loaderOptions?.systemPrompt).toBe('custom prompt');
    // M4：预设白名单会并入内联扩展注册的工具（SDK 的 tools 是可用工具白名单，
    // 不在名单里的工具连调用都失败 —— 计划工具必须并进去）。
    expect(options.tools).toEqual([
      'submit_plan',
      'update_plan',
      'complete_step',
      'block_step',
      'ask_user',
    ]);
    expect(options.thinkingLevel).toBe('off');
    expect(options.settingsManager).toBeDefined();
    expect(mocks.SettingsManager.create).toHaveBeenCalledWith('/tmp/workspace', agentDir);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: false, keepRecentTokens: 8000, reserveTokens: 16384 },
    });
  });

  it('keeps the default path unchanged when preset fields are absent', async () => {
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({ cwd: '/tmp/workspace' });

    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(loaderOptions?.systemPrompt).toBeUndefined(); // 空/未传 → 不覆盖 loader 提示词
    expect(options.tools).toBeUndefined(); // 未指定工具 → SDK 默认工具集
    expect(options.thinkingLevel).toBeUndefined();
    expect(options.settingsManager).toBeUndefined();
    expect(mocks.SettingsManager.create).not.toHaveBeenCalled();
  });

  it('does not pass an empty systemPrompt to the loader', async () => {
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({ cwd: '/tmp/workspace', systemPrompt: '' });

    expect(loaderOptions?.systemPrompt).toBeUndefined();
  });

  it('resolves an explicit model and forwards it', async () => {
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({ cwd: '/tmp/workspace', provider: 'anthropic', modelId: 'claude-x' });

    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(options.model).toEqual({ provider: 'anthropic', modelId: 'claude-x' });
  });

  it('injects approval/plan inline extensions by default and gates them off by preset', async () => {
    const factory = new OriginalPiSessionFactory(
      agentDir,
      undefined,
      new ToolApprovalBroker(),
      new PlanModeService(),
    );

    await factory.create({ cwd: '/tmp/workspace' });
    const factories = (loaderOptions?.extensionFactories as unknown[] | undefined) ?? [];
    expect(factories).toHaveLength(2); // plan + approval

    await factory.create({ cwd: '/tmp/workspace', extensions: { approval: false } });
    expect((loaderOptions?.extensionFactories as unknown[]).length).toBe(1);

    await factory.create({ cwd: '/tmp/workspace', extensions: { planMode: false } });
    expect((loaderOptions?.extensionFactories as unknown[]).length).toBe(1);

    await factory.create({
      cwd: '/tmp/workspace',
      extensions: { approval: false, planMode: false },
    });
    expect((loaderOptions?.extensionFactories as unknown[]).length).toBe(0);
  });
});

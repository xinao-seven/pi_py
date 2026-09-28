/**
 * 验证 OriginalPiSessionFactory 把预设的 systemPrompt / compaction / 工具 / 思考等级
 * 正确透传给 createAgentSession。mock 掉 SDK，捕获 createAgentSession 的 options。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  DefaultResourceLoader: vi.fn(),
  ModelRuntime: { create: vi.fn() },
  SessionManager: { listAll: vi.fn(), open: vi.fn(), create: vi.fn() },
  SettingsManager: { create: vi.fn() },
}));

vi.mock('@earendil-works/pi-coding-agent', () => mocks);

import { OriginalPiSessionFactory } from '../../../src/services/agent/agent-registry.js';
import { PlanModeService } from '../../../src/services/plan/plan-mode-service.js';
import { QuestionBroker } from '../../../src/services/agent/user-question.js';
import { ToolApprovalBroker } from '../../../src/services/agent/tool-approval.js';

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
    // 顺序即请求里的工具数组顺序：跟随 PLAN_TOOL_NAMES，会话生命周期内不变（缓存前缀稳定）。
    // M5：`subagent` 同样会并入（之前漏并，导致带白名单的预设会话里调不动它）。
    expect(options.tools).toEqual([
      'propose_plan',
      'submit_plan',
      'update_plan',
      'complete_step',
      'block_step',
      'ask_user',
      'subagent',
    ]);
    // tools 是「可用工具白名单」：ask_user 属于通用交互，必须一并并入。
    expect(options.thinkingLevel).toBe('off');
    expect(options.settingsManager).toBeDefined();
    expect(mocks.SettingsManager.create).toHaveBeenCalledWith('/tmp/workspace', agentDir);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: false, keepRecentTokens: 8000, reserveTokens: 16384 },
    });
  });

  it('applies platform compaction defaults when the preset gives none', async () => {
    const applyOverrides = vi.fn();
    mocks.SettingsManager.create.mockReturnValue({ applyOverrides });
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({ cwd: '/tmp/workspace' });

    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(loaderOptions?.systemPrompt).toBeUndefined(); // 空/未传 → 不覆盖 loader 提示词
    expect(options.tools).toBeUndefined(); // 未指定工具 → SDK 默认工具集
    expect(options.thinkingLevel).toBeUndefined();
    // 平台默认压缩策略：无模型窗口时不做触发点换算，只换 keepRecent（SDK 缺省 20K → 48K）。
    expect(options.settingsManager).toBeDefined();
    expect(mocks.SettingsManager.create).toHaveBeenCalledWith('/tmp/workspace', agentDir);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 48000 },
    });
  });

  it('caps the compaction trigger point at 200K for a 1M-window model', async () => {
    mocks.ModelRuntime.create.mockResolvedValue({
      getModel: () => ({ provider: 'deepseek', modelId: 'flash', contextWindow: 1_000_000 }),
    });
    const applyOverrides = vi.fn();
    mocks.SettingsManager.create.mockReturnValue({ applyOverrides });
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({ cwd: '/tmp/workspace', provider: 'deepseek', modelId: 'flash' });

    // 触发点 = 1M - reserveTokens = 200K。
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: true, reserveTokens: 800_000, keepRecentTokens: 48_000 },
    });
  });

  it('keeps minimal (all-capabilities-off) sessions on stock SDK behavior', async () => {
    mocks.ModelRuntime.create.mockResolvedValue({
      getModel: () => ({ provider: 'deepseek', modelId: 'flash', contextWindow: 1_000_000 }),
    });
    const applyOverrides = vi.fn();
    mocks.SettingsManager.create.mockReturnValue({ applyOverrides });
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({
      cwd: '/tmp/workspace',
      provider: 'deepseek',
      modelId: 'flash',
      extensions: {
        planMode: false,
        approval: false,
        questions: false,
        subagents: false,
        tasks: false,
        observability: false,
        fileExtensions: false,
      },
    });

    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    // 极简 = 原版行为：压缩不做平台加成（跟随 settings.json / SDK 缺省）、
    // 不注册工具结果预算扩展、系统提示词不追加并行调用提示。
    expect(options.settingsManager).toBeUndefined();
    expect(mocks.SettingsManager.create).not.toHaveBeenCalled();
    expect(loaderOptions?.extensionFactories).toEqual([]);
    expect(loaderOptions?.appendSystemPromptOverride).toBeUndefined();
  });

  it('appends parallel-tool-call guidance to the system prompt for non-stock sessions', async () => {
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({ cwd: '/tmp/workspace' });

    const override = loaderOptions?.appendSystemPromptOverride as
      ((base: string[]) => string[]) | undefined;
    expect(override).toBeDefined();
    expect(override!(['user append file'])).toEqual([
      'user append file',
      expect.stringContaining('并行'),
    ]);
    // 追加不覆盖：预设提示词与用户 append 文件都还在。
    expect(override!([])).toHaveLength(1);
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
    expect(factories).toHaveLength(3); // plan + approval + 工具结果预算（平台策略）

    await factory.create({ cwd: '/tmp/workspace', extensions: { approval: false } });
    expect((loaderOptions?.extensionFactories as unknown[]).length).toBe(2);

    await factory.create({ cwd: '/tmp/workspace', extensions: { planMode: false } });
    expect((loaderOptions?.extensionFactories as unknown[]).length).toBe(2);

    await factory.create({
      cwd: '/tmp/workspace',
      extensions: { approval: false, planMode: false },
    });
    expect((loaderOptions?.extensionFactories as unknown[]).length).toBe(1);
  });

  it('injects the question channel by default and can gate it off', async () => {
    const factory = new OriginalPiSessionFactory(
      agentDir,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new QuestionBroker(),
    );
    await factory.create({ cwd: '/tmp/workspace' });
    expect((loaderOptions?.extensionFactories as unknown[] | undefined)?.length).toBe(2);

    await factory.create({ cwd: '/tmp/workspace', extensions: { questions: false } });
    expect((loaderOptions?.extensionFactories as unknown[] | undefined)?.length).toBe(1);
  });

  it('gates each inline tool by its capability switch', async () => {
    const factory = new OriginalPiSessionFactory(agentDir);
    const toolsOf = (): string[] | undefined => {
      const calls = mocks.createAgentSession.mock.calls;
      return (calls[calls.length - 1][0] as Record<string, unknown>).tools as string[] | undefined;
    };

    await factory.create({ cwd: '/tmp/workspace', toolNames: [] });
    expect(toolsOf()).toEqual([
      'propose_plan',
      'submit_plan',
      'update_plan',
      'complete_step',
      'block_step',
      'ask_user',
      'subagent',
    ]);

    // 三项都关掉时，白名单里不再并入任何内联工具。
    await factory.create({
      cwd: '/tmp/workspace',
      toolNames: [],
      extensions: { planMode: false, questions: false, subagents: false },
    });
    expect(toolsOf()).toEqual([]);

    // toolNames 缺省 = SDK 默认发现（不传 tools 选项），不受能力开关影响。
    await factory.create({ cwd: '/tmp/workspace', extensions: { planMode: false } });
    expect(toolsOf()).toBeUndefined();
  });

  it('suppresses file extension discovery in minimal mode', async () => {
    const MINIMAL = {
      planMode: false,
      approval: false,
      questions: false,
      subagents: false,
      tasks: false,
      observability: false,
      fileExtensions: false,
    };
    const factory = new OriginalPiSessionFactory(agentDir);

    // 全能力关闭（真·极简）：平台策略（工具结果预算）也不注册。
    await factory.create({ cwd: '/tmp/workspace', extensions: { ...MINIMAL } });
    expect(loaderOptions?.noExtensions).toBe(true);
    expect(loaderOptions?.extensionFactories).toEqual([]);

    // 默认：不传 noExtensions，SDK 照常发现用户级/工作区级扩展。
    await factory.create({ cwd: '/tmp/workspace' });
    expect(loaderOptions?.noExtensions).toBeUndefined();
  });

  it('skips the MCP extension when the preset disables every server', async () => {
    const mcpService = {
      ensure: vi.fn(async () => undefined),
      toolsFor: vi.fn(() => [{ name: 'mcp__demo', description: '', parameters: {} }]),
      approvalRequired: vi.fn(() => false),
    };
    const factory = new OriginalPiSessionFactory(agentDir, mcpService as never);

    await factory.create({ cwd: '/tmp/workspace', mcpServers: [] });
    expect(loaderOptions?.extensionFactories).toHaveLength(1); // 工具结果预算（MCP 被禁用，不注册）
    expect(mcpService.toolsFor).not.toHaveBeenCalled();

    // null/缺省 = 全部 MCP：扩展照旧注册。
    await factory.create({ cwd: '/tmp/workspace' });
    expect((loaderOptions?.extensionFactories as unknown[]).length).toBe(2);
  });
});

/**
 * 预设配置落盘（只在 create 方向）：极简这类开关必须随会话写下来，否则重开只能按「全开」重建。
 */
describe('OriginalPiSessionFactory 把预设配置写进会话 JSONL', () => {
  const agentDir = '/tmp/fake-pi-agent';
  const MINIMAL = {
    approval: false,
    planMode: false,
    questions: false,
    subagents: false,
    tasks: false,
    observability: false,
    fileExtensions: false,
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.DefaultResourceLoader.mockImplementation(function (
      this: unknown,
      options: Record<string, unknown>,
    ) {
      return { reload: vi.fn().mockResolvedValue(undefined), options };
    });
    mocks.ModelRuntime.create.mockResolvedValue({
      getModel: (provider: string, modelId: string) => ({ provider, modelId }),
    });
  });

  /** 让 createAgentSession 返回带 sessionManager 的假会话，并给出 appendCustomEntry 桩。 */
  function sessionWith(appendCustomEntry: unknown): void {
    mocks.createAgentSession.mockResolvedValue({
      session: { sessionId: 'session-with-config', sessionManager: { appendCustomEntry } },
    });
  }

  it('writes the preset config as a pi-web/session-config custom entry', async () => {
    const appendCustomEntry = vi.fn();
    sessionWith(appendCustomEntry);
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({
      cwd: '/tmp/workspace',
      extensions: { ...MINIMAL },
      toolNames: [],
      systemPrompt: 'You are terse.',
      compaction: { enabled: true, keepRecentTokens: 8000, reserveTokens: 16384 },
      mcpServers: [],
    });

    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
    expect(appendCustomEntry).toHaveBeenCalledWith('pi-web/session-config', {
      extensions: { ...MINIMAL },
      toolNames: [],
      systemPrompt: 'You are terse.',
      compaction: { enabled: true, keepRecentTokens: 8000, reserveTokens: 16384 },
      mcpServers: [],
    });
  });

  it('writes the resolved platform compaction when no preset field was given', async () => {
    const appendCustomEntry = vi.fn();
    sessionWith(appendCustomEntry);
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({ cwd: '/tmp/workspace' });

    // 无预设字段的会话现在会落盘「解析后的压缩策略」——重开时不再依赖模型目录即可复现。
    expect(appendCustomEntry).toHaveBeenCalledTimes(1);
    expect(appendCustomEntry).toHaveBeenCalledWith('pi-web/session-config', {
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 48000 },
    });
  });

  it('does not write for subagent sessions (they are never reopened from disk)', async () => {
    const appendCustomEntry = vi.fn();
    sessionWith(appendCustomEntry);
    mocks.SessionManager.create.mockReturnValue({ getSessionFile: () => '/tmp/sub.jsonl' });
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.create({
      cwd: '/tmp/workspace',
      extensions: { ...MINIMAL },
      mcpServers: [],
      subagent: {
        parentSessionId: 'parent',
        preset: 'scout',
        depth: 1,
        maxDepth: 2,
        sessionDir: '/tmp/subagents',
      },
    });

    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it('keeps the session usable when the append fails (warn only)', async () => {
    const warn = vi.fn();
    sessionWith(() => {
      throw new Error('disk full');
    });
    const factory = new OriginalPiSessionFactory(agentDir, undefined, undefined, undefined, {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });

    const session = await factory.create({ cwd: '/tmp/workspace', mcpServers: [] });

    expect(session.sessionId).toBe('session-with-config');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('tolerates sessions without a sessionManager', async () => {
    mocks.createAgentSession.mockResolvedValue({ session: { sessionId: 'no-manager' } });
    const factory = new OriginalPiSessionFactory(agentDir);

    await expect(factory.create({ cwd: '/tmp/workspace', mcpServers: [] })).resolves.toMatchObject({
      sessionId: 'no-manager',
    });
  });
});

/**
 * 从磁盘恢复：落盘配置必须被真的用来重建会话（这是「极简重开之后还是极简」的服务端一侧）。
 */
describe('OriginalPiSessionFactory.open 读回配置', () => {
  const agentDir = '/tmp/fake-pi-agent';
  const MINIMAL = {
    approval: false,
    planMode: false,
    questions: false,
    subagents: false,
    tasks: false,
    observability: false,
    fileExtensions: false,
  } as const;
  const input = {
    id: 'persisted-1',
    path: '/tmp/sessions/persisted-1.jsonl',
    cwd: '/tmp/ws',
    created: new Date(0),
    modified: new Date(0),
    messageCount: 0,
    firstMessage: '',
  };
  let loaderOptions: Record<string, unknown> | undefined;

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
    mocks.ModelRuntime.create.mockResolvedValue({ getModel: vi.fn() });
    mocks.createAgentSession.mockResolvedValue({ session: { sessionId: 'persisted-1' } });
    mocks.SessionManager.open.mockReturnValue({
      getCwd: () => '/tmp/ws',
      getEntries: () => [],
    });
  });

  /** 让 SessionManager.open 返回带指定配置条目的会话文件。 */
  function withConfig(data: unknown): void {
    mocks.SessionManager.open.mockReturnValue({
      getCwd: () => '/tmp/ws',
      getEntries: () => [{ type: 'custom', customType: 'pi-web/session-config', data }],
    });
  }

  it('极简会话重开：不加载用户扩展、不注册任何内联扩展、白名单不并入计划工具', async () => {
    withConfig({ extensions: { ...MINIMAL }, toolNames: ['read'], mcpServers: [] });
    const factory = new OriginalPiSessionFactory(
      agentDir,
      undefined,
      new ToolApprovalBroker(),
      new PlanModeService(),
    );

    const opened = await factory.open(input);

    expect(opened.config).toEqual({
      extensions: { ...MINIMAL },
      toolNames: ['read'],
      mcpServers: [],
    });
    expect(loaderOptions?.noExtensions).toBe(true);
    expect(loaderOptions?.extensionFactories).toEqual([]);
    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(options.tools).toEqual(['read']);
  });

  it('重开时仍按配置并入内联工具（白名单是可用集，漏并就调不动）', async () => {
    withConfig({ extensions: { ...MINIMAL, planMode: true, approval: true }, toolNames: ['read'] });
    const factory = new OriginalPiSessionFactory(
      agentDir,
      undefined,
      new ToolApprovalBroker(),
      new PlanModeService(),
    );

    await factory.open(input);

    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(options.tools).toEqual([
      'read',
      'propose_plan',
      'submit_plan',
      'update_plan',
      'complete_step',
      'block_step',
    ]);
  });

  it('重开时恢复系统提示词与压缩策略', async () => {
    withConfig({
      systemPrompt: 'You are terse.',
      compaction: { enabled: false, keepRecentTokens: 8000, reserveTokens: 16384 },
    });
    const applyOverrides = vi.fn();
    mocks.SettingsManager.create.mockReturnValue({ applyOverrides });
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.open(input);

    expect(loaderOptions?.systemPrompt).toBe('You are terse.');
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: false, keepRecentTokens: 8000, reserveTokens: 16384 },
    });
  });

  it('旧会话（没有配置条目）补平台默认压缩策略，其余保持改动前行为', async () => {
    const applyOverrides = vi.fn();
    mocks.SettingsManager.create.mockReturnValue({ applyOverrides });
    const factory = new OriginalPiSessionFactory(agentDir);

    const opened = await factory.open(input);

    expect(opened.config).toBeUndefined();
    expect(loaderOptions?.noExtensions).toBeUndefined();
    expect(loaderOptions?.systemPrompt).toBeUndefined();
    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, undefined>;
    expect(options.tools).toBeUndefined();
    // 旧会话没有 compaction 字段：按非极简（缺省全开）处理，补平台默认（无模型窗口时不换算触发点）。
    expect(options.settingsManager).toBeDefined();
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 48000 },
    });
  });

  it('旧会话按 model_change 条目恢复模型窗口并换算压缩触发点', async () => {
    mocks.SessionManager.open.mockReturnValue({
      getCwd: () => '/tmp/ws',
      getEntries: () => [
        { type: 'session', id: 's1' },
        { type: 'model_change', provider: 'deepseek', modelId: 'flash' },
      ],
    });
    mocks.ModelRuntime.create.mockResolvedValue({
      getModel: (provider: string, modelId: string) => ({
        provider,
        modelId,
        contextWindow: 1_000_000,
      }),
    });
    const applyOverrides = vi.fn();
    mocks.SettingsManager.create.mockReturnValue({ applyOverrides });
    const factory = new OriginalPiSessionFactory(agentDir);

    await factory.open(input);

    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: true, reserveTokens: 800_000, keepRecentTokens: 48_000 },
    });
  });

  it('model_change 指向模型目录里不存在的模型时降级：不换算触发点也不失败', async () => {
    mocks.SessionManager.open.mockReturnValue({
      getCwd: () => '/tmp/ws',
      getEntries: () => [{ type: 'model_change', provider: 'ghost', modelId: 'gone' }],
    });
    mocks.ModelRuntime.create.mockResolvedValue({ getModel: () => undefined });
    const applyOverrides = vi.fn();
    mocks.SettingsManager.create.mockReturnValue({ applyOverrides });
    const factory = new OriginalPiSessionFactory(agentDir);

    await expect(factory.open(input)).resolves.toMatchObject({
      session: { sessionId: 'persisted-1' },
    });
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 48000 },
    });
  });

  it('配置条目坏掉时按「没有配置」恢复，不让打开会话失败', async () => {
    withConfig({ extensions: 'broken' });
    const factory = new OriginalPiSessionFactory(agentDir);

    const opened = await factory.open(input);

    expect(opened.config).toBeUndefined();
    const options = mocks.createAgentSession.mock.calls[0][0] as Record<string, unknown>;
    expect(options.tools).toBeUndefined();
  });

  it('getEntries 抛错时降级为「没有配置」', async () => {
    mocks.SessionManager.open.mockReturnValue({
      getCwd: () => '/tmp/ws',
      getEntries: () => {
        throw new Error('corrupted file');
      },
    });
    const factory = new OriginalPiSessionFactory(agentDir);

    await expect(factory.open(input)).resolves.toMatchObject({
      session: { sessionId: 'persisted-1' },
    });
  });
});

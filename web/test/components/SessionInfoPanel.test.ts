import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionInfoPanel from '@/components/SessionInfoPanel.vue';
import { ApiError, getSessionPrompt } from '@/lib/api';
import type { SessionPromptSnapshot } from '@/types';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { getSessionPrompt: vi.fn(), ApiError: actual.ApiError };
});

function snapshot(overrides: Partial<SessionPromptSnapshot> = {}): SessionPromptSnapshot {
  return {
    sessionId: 'session-1',
    cwd: '/workspace',
    capturedAt: '2026-09-27T10:00:00.000Z',
    model: { provider: 'deepseek', modelId: 'deepseek-chat' },
    thinkingLevel: 'medium',
    overview: {
      systemPromptChars: 4_213,
      systemPromptTruncated: false,
      toolsRegistered: 3,
      toolsActive: 2,
      mcpTools: 1,
      skills: 1,
      promptTemplates: 1,
      contextFiles: 1,
    },
    systemPrompt: {
      text: 'You are pi.\nFollow the guidelines.',
      source: '/home/u/.pi/agent/prompts/system.md',
      appendedPrompts: 1,
    },
    tools: [
      {
        name: 'read',
        description: 'Read a file',
        params: [{ name: 'path', required: true }],
        source: 'builtin',
        sourcePath: '<builtin:read>',
        active: true,
        promptGuidelines: ['Prefer absolute paths'],
      },
      {
        name: 'bash',
        description: 'Run a command',
        params: [{ name: 'command', required: true }],
        source: 'builtin',
        sourcePath: '<builtin:bash>',
        active: false,
        promptGuidelines: [],
      },
      {
        name: 'mcp__github__list_issues',
        description: 'List issues',
        params: [],
        source: 'mcp',
        sourcePath: '<inline>',
        active: true,
        mcp: { server: 'github', tool: 'list_issues' },
        promptGuidelines: [],
      },
    ],
    skills: [
      {
        name: 'tavily-search',
        description: 'Web search',
        location: '/home/u/.pi/agent/skills/tavily-search/SKILL.md',
        disableModelInvocation: false,
      },
    ],
    promptTemplates: [
      { name: 'review', description: 'Review a diff', argumentHint: '<pr>', path: '/p/review.md' },
    ],
    contextFiles: [{ path: '/workspace/CLAUDE.md', chars: 120 }],
    diagnostics: [],
    ...overrides,
  };
}

async function openPanel(overrides: Partial<SessionPromptSnapshot> = {}) {
  vi.mocked(getSessionPrompt).mockResolvedValue({ snapshot: snapshot(overrides) });
  const wrapper = mount(SessionInfoPanel, { props: { sessionId: 'session-1' } });
  await wrapper.get('.session-info-button').trigger('click');
  await flushPromises();
  return wrapper;
}

describe('SessionInfoPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not request anything until the button is clicked', async () => {
    const wrapper = mount(SessionInfoPanel, { props: { sessionId: 'session-1' } });

    expect(getSessionPrompt).not.toHaveBeenCalled();
    expect(wrapper.find('.session-info-dialog').exists()).toBe(false);
  });

  it('loads the snapshot on first open and renders the overview chips', async () => {
    const wrapper = await openPanel();

    expect(getSessionPrompt).toHaveBeenCalledWith('session-1');
    const text = wrapper.text();
    expect(text).toContain('deepseek/deepseek-chat');
    expect(text).toContain('/workspace');
    // 系统提示词字符数按千位格式化；工具用「已激活/已注册」。
    expect(text).toContain('4.2k 字');
    expect(text).toContain('2/3');
    expect(text).toContain('MCP');
  });

  it('groups tools by source and marks active/inactive with the required params', async () => {
    const wrapper = await openPanel();
    const text = wrapper.text();

    expect(text).toContain('内置工具');
    expect(text).toContain('MCP 工具');
    expect(text).toContain('已激活');
    expect(text).toContain('未激活');
    // 必填参数带 *，未注册的工具也不会被当成激活（bash 是注册但未激活）。
    expect(text).toContain('参数：path*');
    expect(text).toContain('Prefer absolute paths');

    // MCP 工具额外按 server 分组，显示 server 与真实工具名。
    expect(text).toContain('github');
    expect(text).toContain('list_issues');
    expect(text).toContain('mcp__github__list_issues');
  });

  it('renders skills, prompt templates and context files', async () => {
    const wrapper = await openPanel();
    const text = wrapper.text();

    expect(text).toContain('tavily-search');
    expect(text).toContain('/home/u/.pi/agent/skills/tavily-search/SKILL.md');
    expect(text).toContain('Skills（1）');
    expect(text).toContain('提示词模板（1）');
    expect(text).toContain('review');
    expect(text).toContain('上下文文件（1）');
    expect(text).toContain('/workspace/CLAUDE.md');
    expect(text).toContain('120 字');
  });

  it('keeps the system prompt collapsed until asked, then copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = await openPanel();

    const section = wrapper.get('.session-info-section');
    expect(section.attributes('open')).toBeUndefined();
    // 未展开时正文不在可见文本里（details 的折叠由浏览器负责，DOM 里仍在）。
    expect(wrapper.get('.session-info-pre').text()).toContain('You are pi.');

    await wrapper.get('.session-info-section-actions button').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith('You are pi.\nFollow the guidelines.');
    expect(wrapper.get('.session-info-section-actions button').text()).toBe('已复制');
    vi.unstubAllGlobals();
  });

  it('surfaces clipboard failures instead of pretending success', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const wrapper = await openPanel();

    await wrapper.get('.session-info-section-actions button').trigger('click');
    await flushPromises();

    expect(wrapper.get('.session-info-error').text()).toContain('复制失败');
    vi.unstubAllGlobals();
  });

  it('shows resource diagnostics and the truncation notice', async () => {
    const wrapper = await openPanel({
      diagnostics: ['SKILL.md 缺少 description'],
      overview: {
        ...snapshot().overview,
        systemPromptTruncated: true,
      },
    });

    expect(wrapper.text()).toContain('资源诊断：SKILL.md 缺少 description');
    expect(wrapper.text()).toContain('展示已截断');
  });

  it('reloads on demand and surfaces load errors', async () => {
    const wrapper = await openPanel();
    expect(getSessionPrompt).toHaveBeenCalledTimes(1);

    const updated = snapshot({ overview: { ...snapshot().overview, skills: 2 } });
    updated.skills = [
      ...updated.skills,
      {
        name: 'extra-skill',
        description: 'Second skill',
        location: '/skills/extra/SKILL.md',
        disableModelInvocation: false,
      },
    ];
    vi.mocked(getSessionPrompt).mockResolvedValue({ snapshot: updated });
    await wrapper.get('.session-info-actions button').trigger('click');
    await flushPromises();

    expect(getSessionPrompt).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('Skills（2）');
    expect(wrapper.text()).toContain('extra-skill');

    // 后端报错（例如会话已关闭）：显示错误，旧内容仍留着。
    vi.mocked(getSessionPrompt).mockRejectedValue(
      new ApiError('会话不在活跃状态', 404, 'agent_not_active'),
    );
    await wrapper.get('.session-info-actions button').trigger('click');
    await flushPromises();
    expect(wrapper.get('.session-info-error').text()).toContain('会话不在活跃状态');
  });

  it('closes on Escape and on backdrop click, and stays disabled without a session', async () => {
    const wrapper = await openPanel();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(wrapper.find('.session-info-dialog').exists()).toBe(false);

    await wrapper.get('.session-info-button').trigger('click');
    await flushPromises();
    // 第二次打开用的是缓存（不重复请求），仍然是同一次调用。
    expect(getSessionPrompt).toHaveBeenCalledTimes(1);
    await wrapper.get('.modal-backdrop').trigger('click');
    expect(wrapper.find('.session-info-dialog').exists()).toBe(false);

    const withoutSession = mount(SessionInfoPanel, { props: { sessionId: null } });
    expect(withoutSession.get('.session-info-button').attributes('disabled')).toBeDefined();
  });

  it('refetches when the active session changes', async () => {
    const wrapper = await openPanel();

    await wrapper.setProps({ sessionId: 'session-2' });
    await flushPromises();

    expect(getSessionPrompt).toHaveBeenLastCalledWith('session-2');
  });
});

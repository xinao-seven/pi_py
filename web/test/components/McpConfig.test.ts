import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import McpConfig from '@/components/McpConfig.vue';
import type { McpTemplate } from '@/types';

const { getMcpServers, getMcpTemplates, upsertMcpServer, deleteMcpServer, updateMcpServer, testMcpServer } =
  vi.hoisted(() => ({
    getMcpServers: vi.fn(),
    getMcpTemplates: vi.fn(),
    upsertMcpServer: vi.fn(),
    deleteMcpServer: vi.fn(),
    updateMcpServer: vi.fn(),
    testMcpServer: vi.fn(),
  }));

vi.mock('@/lib/api', () => ({
  getMcpServers,
  getMcpTemplates,
  upsertMcpServer,
  deleteMcpServer,
  updateMcpServer,
  testMcpServer,
}));

function template(overrides: Partial<McpTemplate> = {}): McpTemplate {
  return {
    id: 'memory',
    name: 'memory',
    title: '本地知识图谱（Memory）',
    group: 'core',
    description: '跨会话记住项目约定、模块关系与踩坑结论。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    access: 'local-write',
    suggestApproval: false,
    toolCountHint: '~9',
    homepage: 'https://github.com/modelcontextprotocol/servers',
    requiresCredentials: false,
    canAddDirectly: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMcpServers.mockResolvedValue({ servers: [] });
  getMcpTemplates.mockResolvedValue([
    template(),
    template({
      id: 'tavily',
      name: 'tavily',
      title: '联网搜索与抓取（Tavily）',
      group: 'research',
      description: '搜索、抓正文、爬站点的三件套。',
      args: ['-y', 'tavily-mcp'],
      env: { TAVILY_API_KEY: '$TAVILY_API_KEY' },
      access: 'read-only',
      requiresCredentials: true,
      canAddDirectly: false,
      toolCountHint: '~3',
    }),
    template({
      id: 'filesystem',
      name: 'filesystem',
      title: '受限目录文件读写（Filesystem）',
      group: 'code',
      description: '在指定根目录内读写文件。',
      access: 'local-write',
      suggestApproval: true,
      needsInput: '必须追加「允许访问的根目录」到参数末尾',
      canAddDirectly: false,
    }),
  ]);
  upsertMcpServer.mockResolvedValue(undefined);
});

async function mountPanel() {
  const wrapper = mount(McpConfig, { props: { cwd: 'E:/ws' } });
  await flushPromises();
  await wrapper.get('.config-presets button:nth-child(2)').trigger('click');
  return wrapper;
}

describe('McpConfig 模板库（M4.2）', () => {
  it('loads the catalog and renders it grouped with risk badges', async () => {
    const wrapper = await mountPanel();
    expect(getMcpTemplates).toHaveBeenCalled();
    // 展开后按钮文案变成「收起模板库」
    expect(wrapper.text()).toContain('收起模板库');
    expect(wrapper.text()).toContain('通用能力');
    expect(wrapper.text()).toContain('联网检索与文档');
    expect(wrapper.text()).toContain('代码 / 仓库');

    const card = wrapper.findAll('.mcp-template-card')[0];
    expect(card.text()).toContain('本地知识图谱（Memory）');
    expect(card.text()).toContain('本地写');
    expect(card.text()).toContain('工具 ~9');
    expect(card.text()).toContain('npx -y @modelcontextprotocol/server-memory');
  });

  it('adds a credential-free template in one click', async () => {
    const wrapper = await mountPanel();
    const memoryCard = wrapper.findAll('.mcp-template-card')[0];
    await memoryCard.get('button').trigger('click');
    await flushPromises();

    expect(upsertMcpServer).toHaveBeenCalledWith({
      name: 'memory',
      cwd: 'E:/ws',
      scope: 'user',
      server: {
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
    });
    expect(wrapper.text()).toContain('已添加');
    // 添加后重新拉列表（状态徽标要能刷新）
    expect(getMcpServers).toHaveBeenCalledTimes(2);
  });

  it('only prefills templates that need credentials or extra input', async () => {
    const wrapper = await mountPanel();
    const cards = wrapper.findAll('.mcp-template-card');

    // 需要凭据的模板：没有「一键添加」，只有「填入表单」
    const tavily = cards[1];
    expect(tavily.text()).toContain('需要凭据');
    expect(tavily.findAll('button')).toHaveLength(1);
    expect(tavily.get('button').text()).toBe('填入表单');

    await tavily.get('button').trigger('click');
    const fields = wrapper.findAll('.mcp-form input, .mcp-form textarea');
    const values = fields.map((field) => (field.element as HTMLInputElement).value);
    expect(values).toContain('tavily'); // 名称
    // 参数输入框里是空格分隔的一段文本
    expect(values.some((value) => value.includes('tavily-mcp'))).toBe(true);
    expect(values.join('\n')).toContain('TAVILY_API_KEY: $TAVILY_API_KEY');
  });

  it('shows what the user must fill in and suggests approval for risky templates', async () => {
    const wrapper = await mountPanel();
    const filesystem = wrapper.findAll('.mcp-template-card')[2];
    expect(filesystem.text()).toContain('需填参数');
    expect(filesystem.text()).toContain('建议审批');
    expect(filesystem.text()).toContain('需要你补充：必须追加「允许访问的根目录」到参数末尾');
    expect(filesystem.get('a').attributes('href')).toContain('github.com');
  });

  it('prefills approval checkbox from the template suggestion', async () => {
    const wrapper = await mountPanel();
    await wrapper.findAll('.mcp-template-card')[2].get('button').trigger('click');
    const approval = wrapper
      .findAll('.mcp-form input[type="checkbox"]')
      .map((input) => input.element as HTMLInputElement)
      .find((input) => input.checked);
    expect(approval).toBeDefined();
  });

  it('survives a template fetch failure (falls back to manual add)', async () => {
    getMcpTemplates.mockRejectedValue(new Error('offline'));
    const wrapper = mount(McpConfig, { props: { cwd: 'E:/ws' } });
    await flushPromises();
    expect(wrapper.text()).toContain('＋ 添加 Server');
    expect(wrapper.find('.mcp-templates').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('模板库');
  });
});

import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import { beforeEach } from 'vitest';
import { createPreset, getMcpServers, getModels, getPresets } from '@/lib/api';
import PresetConfig from '@/components/PresetConfig.vue';
import type { PresetCapabilities } from '@/types';

vi.mock('@/lib/api', () => ({
  createPreset: vi.fn(),
  deletePreset: vi.fn(),
  getMcpServers: vi.fn(),
  getModels: vi.fn(),
  getPresets: vi.fn(),
  updatePreset: vi.fn(),
}));

const catalog = {
  models: { 'alpha:a': 'Alpha', 'beta:b': 'Beta' },
  modelList: [
    { id: 'a', name: 'Alpha', provider: 'alpha' },
    { id: 'b', name: 'Beta', provider: 'beta' },
  ],
  defaultModel: { provider: 'alpha', modelId: 'a' },
  thinkingLevels: { 'alpha:a': ['off', 'high'], 'beta:b': ['off'] },
  thinkingLevelMaps: {},
};

const ALL_CAPABILITIES: PresetCapabilities = {
  plan: true,
  approval: true,
  questions: true,
  subagent: true,
  tasks: true,
  observability: true,
  fileExtensions: true,
};

const presets = [
  {
    id: 'coding-agent',
    name: 'Coding Agent（默认）',
    builtin: true,
    systemPrompt: '',
    toolNames: ['read', 'bash', 'edit', 'write'] as string[] | null,
    compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 } as {
      enabled: boolean;
      keepRecentTokens: number;
      reserveTokens: number;
    } | null,
    capabilities: { ...ALL_CAPABILITIES },
    provider: '',
    modelId: '',
    thinkingLevel: '',
    mcpServers: null as string[] | null,
  },
  {
    id: 'minimal',
    name: '极简（原版 pi）',
    builtin: true,
    systemPrompt: '',
    toolNames: null,
    compaction: null,
    capabilities: {
      plan: false,
      approval: false,
      questions: false,
      subagent: false,
      tasks: false,
      observability: false,
      fileExtensions: false,
    },
    provider: '',
    modelId: '',
    thinkingLevel: '',
    mcpServers: [],
  },
];

describe('PresetConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // MCP 列表：不关心内容，只避免它把 load() 抛进错误分支。
    vi.mocked(getMcpServers).mockResolvedValue({ servers: [] } as never);
  });

  it('renders the built-in preset with a badge and no edit/delete buttons', async () => {
    vi.mocked(getPresets).mockResolvedValue(presets);
    vi.mocked(getModels).mockResolvedValue(catalog);
    const wrapper = mount(PresetConfig, { props: { embedded: true } });
    await flushPromises();

    expect(wrapper.text()).toContain('Coding Agent（默认）');
    expect(wrapper.find('.preset-badge--builtin').text()).toBe('内置');
    const actions = wrapper.findAll('.preset-actions');
    expect(actions).toHaveLength(0);
  });

  it('renders the minimal built-in preset with everything-off summary', async () => {
    vi.mocked(getPresets).mockResolvedValue(presets);
    vi.mocked(getModels).mockResolvedValue(catalog);
    const wrapper = mount(PresetConfig, { props: { embedded: true } });
    await flushPromises();

    expect(wrapper.text()).toContain('极简（原版 pi）');
    // 工具 = null（SDK 默认发现）；压缩 = null（跟随设置）；能力全关 → 摘要列出关闭项。
    expect(wrapper.text()).toContain('工具：全部（SDK 默认）');
    expect(wrapper.text()).toContain('压缩：跟随设置（不覆盖）');
    expect(wrapper.text()).toContain('关闭：Plan 模式、危险命令审批、向用户提问');
  });

  it('creates a new preset and reloads the list', async () => {
    vi.mocked(getPresets).mockResolvedValue(presets);
    vi.mocked(getModels).mockResolvedValue(catalog);
    vi.mocked(createPreset).mockResolvedValue({
      ...presets[0],
      id: 'new-id',
      builtin: false,
      name: '我的预设',
    });
    const wrapper = mount(PresetConfig, { props: { embedded: true } });
    await flushPromises();

    await wrapper.find('.config-add').trigger('click');
    await wrapper.find('input[placeholder="如 代码审查"]').setValue('我的预设');
    await wrapper.findAll('.config-footer button')[1].trigger('click');
    await flushPromises();

    expect(createPreset).toHaveBeenCalledWith({
      name: '我的预设',
      systemPrompt: '',
      toolNames: ['read', 'bash', 'edit', 'write'],
      compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 },
      // 新预设默认能力全开（与后端缺省一致）。
      capabilities: { ...ALL_CAPABILITIES },
      provider: '',
      modelId: '',
      thinkingLevel: '',
      mcpServers: null,
    });
  });

  it('saves toolNames: null and compaction: null for the all/follow modes', async () => {
    vi.mocked(getPresets).mockResolvedValue(presets);
    vi.mocked(getModels).mockResolvedValue(catalog);
    vi.mocked(createPreset).mockResolvedValue({ ...presets[0], id: 'x', builtin: false });
    const wrapper = mount(PresetConfig, { props: { embedded: true } });
    await flushPromises();

    await wrapper.find('.config-add').trigger('click');
    await wrapper.find('input[placeholder="如 代码审查"]').setValue('不限制');
    await wrapper.find('input[name="toolMode"][value="all"]').setValue();
    await wrapper.find('.preset-form select').setValue('follow');
    await wrapper.findAll('.config-footer button')[1].trigger('click');
    await flushPromises();

    expect(createPreset).toHaveBeenCalledWith(
      expect.objectContaining({ toolNames: null, compaction: null }),
    );
  });

  it('persists the capability switches the user turned off', async () => {
    vi.mocked(getPresets).mockResolvedValue(presets);
    vi.mocked(getModels).mockResolvedValue(catalog);
    vi.mocked(createPreset).mockResolvedValue({ ...presets[0], id: 'x', builtin: false });
    const wrapper = mount(PresetConfig, { props: { embedded: true } });
    await flushPromises();

    await wrapper.find('.config-add').trigger('click');
    await wrapper.find('input[placeholder="如 代码审查"]').setValue('只读助手');
    await wrapper.find('input[name="capability-plan"]').setValue(false);
    await wrapper.find('input[name="capability-tasks"]').setValue(false);
    await wrapper.find('input[name="capability-fileExtensions"]').setValue(false);
    await wrapper.findAll('.config-footer button')[1].trigger('click');
    await flushPromises();

    expect(createPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: {
          plan: false,
          approval: true,
          questions: true,
          subagent: true,
          tasks: false,
          observability: true,
          fileExtensions: false,
        },
      }),
    );
  });
});

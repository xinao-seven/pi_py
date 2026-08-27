import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import { createPreset, getModels, getPresets } from '@/lib/api';
import PresetConfig from '@/components/PresetConfig.vue';

vi.mock('@/lib/api', () => ({
  createPreset: vi.fn(),
  deletePreset: vi.fn(),
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

const presets = [
  {
    id: 'coding-agent',
    name: 'Coding Agent（默认）',
    builtin: true,
    systemPrompt: '',
    toolNames: ['read', 'bash', 'edit', 'write'],
    compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 },
    provider: '',
    modelId: '',
    thinkingLevel: '',
  },
];

describe('PresetConfig', () => {
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
      provider: '',
      modelId: '',
      thinkingLevel: '',
    });
  });
});

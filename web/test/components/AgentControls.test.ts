import { mount } from '@vue/test-utils';

import AgentControls from '@/components/AgentControls.vue';

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
  {
    id: 'review',
    name: '代码审查',
    builtin: false,
    systemPrompt: 'Review code carefully.',
    toolNames: ['read', 'grep'],
    compaction: { enabled: true, keepRecentTokens: 8000, reserveTokens: 16384 },
    provider: 'beta',
    modelId: 'b',
    thinkingLevel: 'high',
  },
];

function baseProps() {
  return {
    catalog,
    model: catalog.defaultModel,
    thinkingLevel: 'off',
    activeTools: ['read', 'bash', 'edit', 'write'],
    presets,
    selectedPreset: 'coding-agent',
    isNew: true,
    compacting: false,
    running: false,
    retryInfo: null,
    contextUsage: null,
    planActive: false,
    planBusy: false,
  };
}

describe('AgentControls', () => {
  it('emits provider-aware model and tool preset changes', async () => {
    const wrapper = mount(AgentControls, { props: baseProps() });
    const selects = wrapper.findAll('select');
    await selects[1].setValue('beta:b');
    await selects[3].setValue('full');

    expect(wrapper.emitted('modelChange')).toEqual([[{ provider: 'beta', modelId: 'b' }]]);
    expect(wrapper.emitted('toolsChange')?.[0]?.[0]).toContain('grep');
  });

  it('shows a preset dropdown for new sessions and emits presetChange', async () => {
    const wrapper = mount(AgentControls, { props: baseProps() });

    const presetSelect = wrapper.find('select');
    expect(presetSelect.exists()).toBe(true);

    await presetSelect.setValue('review');
    expect(wrapper.emitted('presetChange')).toEqual([[presets[1]]]);
  });

  it('hides the preset dropdown for existing sessions', () => {
    const wrapper = mount(AgentControls, { props: { ...baseProps(), isNew: false } });
    const presetLabels = wrapper.findAll('.control-field span');
    expect(presetLabels.some((label) => label.text() === '预设')).toBe(false);
  });
});

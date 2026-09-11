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

describe('AgentControls（M4：不再有 Plan 预开关）', () => {
  it('has no Plan toggle button (planning is chosen when sending)', () => {
    const wrapper = mount(AgentControls, { props: baseProps() });
    const labels = wrapper.findAll('button').map((button) => button.text());
    expect(labels).not.toContain('Plan');
    expect(wrapper.emitted('togglePlan')).toBeUndefined();
    // 压缩按钮仍在。
    expect(labels.some((label) => label.includes('压缩上下文'))).toBe(true);
  });
});

describe('AgentControls 上下文占用条', () => {
  it('renders the fill with a visible class and shows the percentage', () => {
    const wrapper = mount(AgentControls, {
      props: {
        ...baseProps(),
        contextUsage: { tokens: 20_000, contextWindow: 1_000_000, percent: 2 },
      },
    });

    const fill = wrapper.get('.context-meter-fill');
    expect(fill.classes()).toContain('is-visible');
    expect(fill.attributes('style')).toContain('width: 2%');
    expect(wrapper.get('.context-percent').text()).toBe('2%');
  });

  it('hides the meter when context usage is unknown after compaction', () => {
    const wrapper = mount(AgentControls, {
      props: {
        ...baseProps(),
        contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null },
      },
    });

    expect(wrapper.find('.context-usage').exists()).toBe(false);
  });
});

import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import { getModelsConfig, saveModelsConfig } from '@/lib/api';
import ModelsConfig from '@/components/ModelsConfig.vue';

vi.mock('@/lib/api', () => ({
  getModelsConfig: vi.fn(),
  saveModelsConfig: vi.fn(),
}));

describe('ModelsConfig', () => {
  it('round-trips structured provider configuration', async () => {
    vi.mocked(getModelsConfig).mockResolvedValue({
      providers: {
        custom: {
          api: 'openai-completions',
          apiKey: '$CUSTOM_API_KEY',
          models: [{ id: 'custom-model', name: 'Custom Model', contextWindow: 200000 }],
        },
      },
    });
    vi.mocked(saveModelsConfig).mockResolvedValue();
    const wrapper = mount(ModelsConfig);
    await flushPromises();
    await wrapper.findAll('.config-footer button')[1].trigger('click');
    await flushPromises();

    expect(saveModelsConfig).toHaveBeenCalledWith({
      providers: {
        custom: {
          api: 'openai-completions',
          apiKey: '$CUSTOM_API_KEY',
          models: [
            {
              id: 'custom-model',
              name: 'Custom Model',
              contextWindow: 200000,
              reasoning: true,
            },
          ],
        },
      },
    });
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });

  it('adds the current DeepSeek V4 preset with one click', async () => {
    vi.mocked(getModelsConfig).mockResolvedValue({ providers: {} });
    vi.mocked(saveModelsConfig).mockResolvedValue();
    const wrapper = mount(ModelsConfig);
    await flushPromises();
    const presetButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('一键配置 DeepSeek V4'));

    expect(presetButton).toBeDefined();
    await presetButton!.trigger('click');
    await wrapper.findAll('.config-footer button')[1].trigger('click');
    await flushPromises();

    expect(saveModelsConfig).toHaveBeenCalledWith({
      providers: {
        deepseek: {
          api: 'openai-completions',
          baseUrl: 'https://api.deepseek.com',
          apiKey: '$DEEPSEEK_API_KEY',
          models: [
            {
              id: 'deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              contextWindow: 1_000_000,
              reasoning: true,
              cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
              thinkingLevels: ['off', 'low', 'high', 'max'],
            },
            {
              id: 'deepseek-v4-pro',
              name: 'DeepSeek V4 Pro',
              contextWindow: 1_000_000,
              reasoning: true,
              cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
              thinkingLevels: ['off', 'high', 'max'],
            },
          ],
        },
      },
    });
  });

  it('round-trips model prices and drops empty ones', async () => {
    vi.mocked(getModelsConfig).mockResolvedValue({
      providers: {
        custom: {
          api: 'openai-completions',
          models: [
            { id: 'priced', cost: { input: 1.5, output: 2 } },
            { id: 'unpriced', cost: {} },
          ],
        },
      },
    });
    vi.mocked(saveModelsConfig).mockResolvedValue();
    const wrapper = mount(ModelsConfig);
    await flushPromises();
    await wrapper.findAll('.config-footer button')[1].trigger('click');
    await flushPromises();

    expect(saveModelsConfig).toHaveBeenCalledWith({
      providers: {
        custom: {
          api: 'openai-completions',
          models: [
            { id: 'priced', reasoning: true, cost: { input: 1.5, output: 2 } },
            { id: 'unpriced', reasoning: true },
          ],
        },
      },
    });
  });
});

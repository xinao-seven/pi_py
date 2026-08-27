import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';

import SettingsDialog from '@/components/SettingsDialog.vue';

describe('SettingsDialog', () => {
  it('keeps workspace settings disabled without a cwd and emits general actions', async () => {
    const wrapper = mount(SettingsDialog, {
      props: {
        cwd: null,
        theme: 'light',
        soundEnabled: false,
      },
      global: { plugins: [createPinia()] },
    });

    const navButtons = wrapper.findAll('.settings-nav button');
    // 索引：常规 0 / 模型 1 / 预设 2 / Skills 3 / MCP 4（预设无需 cwd，始终可用）。
    expect(navButtons[3].attributes('disabled')).toBeDefined();
    expect(navButtons[4].attributes('disabled')).toBeDefined();

    const generalButtons = wrapper.findAll('.settings-row > button');
    await generalButtons[0].trigger('click');
    await generalButtons[1].trigger('click');
    await wrapper.get('.settings-footer button').trigger('click');

    expect(wrapper.emitted('toggleTheme')).toHaveLength(1);
    expect(wrapper.emitted('toggleSound')).toHaveLength(1);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});

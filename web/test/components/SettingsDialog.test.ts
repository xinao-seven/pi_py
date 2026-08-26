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
    expect(navButtons[2].attributes('disabled')).toBeDefined();
    expect(navButtons[3].attributes('disabled')).toBeDefined();

    const generalButtons = wrapper.findAll('.settings-row > button');
    await generalButtons[0].trigger('click');
    await generalButtons[1].trigger('click');
    await wrapper.get('.settings-footer button').trigger('click');

    expect(wrapper.emitted('toggleTheme')).toHaveLength(1);
    expect(wrapper.emitted('toggleSound')).toHaveLength(1);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});

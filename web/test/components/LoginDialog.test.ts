import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { vi } from 'vitest';

import { login } from '@/lib/api';
import LoginDialog from '@/components/LoginDialog.vue';

vi.mock('@/lib/api', () => ({ login: vi.fn() }));

describe('LoginDialog', () => {
  it('calls login with the entered password on submit', async () => {
    vi.mocked(login).mockResolvedValue(undefined);
    const wrapper = mount(LoginDialog, { global: { plugins: [createPinia()] } });

    await wrapper.get('#login-password-input').setValue('secret');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(login).toHaveBeenCalledWith('secret');
  });

  it('shows an error message on wrong password and keeps the dialog open', async () => {
    vi.mocked(login).mockRejectedValue(new Error('Invalid password'));
    const wrapper = mount(LoginDialog, { global: { plugins: [createPinia()] } });

    await wrapper.get('#login-password-input').setValue('bad');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('Invalid password');
    expect(wrapper.get('form').exists()).toBe(true);
  });
});

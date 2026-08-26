import { createPinia, setActivePinia } from 'pinia';
import { vi } from 'vitest';

import { getAuthStatus, login as apiLogin, logout as apiLogout } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/lib/api', () => ({
  getAuthStatus: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

describe('auth store', () => {
  it('maps status responses: disabled / ok / locked', async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();

    vi.mocked(getAuthStatus).mockResolvedValue({ enabled: false });
    await store.checkStatus();
    expect(store.status).toBe('disabled');

    vi.mocked(getAuthStatus).mockResolvedValue({ enabled: true, authenticated: true });
    await store.checkStatus();
    expect(store.status).toBe('ok');

    vi.mocked(getAuthStatus).mockResolvedValue({ enabled: true, authenticated: false });
    await store.checkStatus();
    expect(store.status).toBe('locked');
  });

  it('treats probe failure (backend down / Python backend without auth) as disabled', async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();

    vi.mocked(getAuthStatus).mockRejectedValue(new Error('404 Not Found'));
    await store.checkStatus();
    expect(store.status).toBe('disabled');
  });

  it('login unlocks and logout locks again', async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();
    store.status = 'locked';

    vi.mocked(apiLogin).mockResolvedValue(undefined);
    await store.login('secret');
    expect(store.status).toBe('ok');

    vi.mocked(apiLogout).mockResolvedValue(undefined);
    await store.logout();
    expect(store.status).toBe('locked');
  });

  it('markLocked clears the persisted token and locks', () => {
    setActivePinia(createPinia());
    const store = useAuthStore();
    window.localStorage.setItem('pi.access_token', 't0ken');

    store.markLocked();

    expect(store.status).toBe('locked');
    expect(window.localStorage.getItem('pi.access_token')).toBeNull();
  });
});

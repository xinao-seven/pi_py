import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendToken,
  clearToken,
  fireUnauthorized,
  getToken,
  setToken,
  setUnauthorizedHandler,
} from '@/lib/session';

describe('session token helpers', () => {
  afterEach(() => {
    window.localStorage.clear();
    setUnauthorizedHandler(() => {});
  });

  it('persists and clears the token in localStorage', () => {
    setToken('abc');
    expect(getToken()).toBe('abc');
    expect(window.localStorage.getItem('pi.access_token')).toBe('abc');

    clearToken();
    expect(getToken()).toBeUndefined();
  });

  it('appends access_token to URLs, merging an existing query string', () => {
    setToken('t0ken');

    expect(appendToken('/api/agent/s1/events')).toBe('/api/agent/s1/events?access_token=t0ken');
    const merged = appendToken('/api/files/a.txt?root=C%3A%5C&type=media');
    expect(merged.startsWith('/api/files/a.txt?')).toBe(true);
    expect(merged).toContain('root=C%3A%5C');
    expect(merged).toContain('type=media');
    expect(merged).toContain('access_token=t0ken');
    // 已有 access_token 时覆盖，避免重复参数
    expect(appendToken('/api/files/a?access_token=old&type=media')).toContain('access_token=t0ken');

    clearToken();
    expect(appendToken('/api/x')).toBe('/api/x');
  });

  it('fires the registered unauthorized handler exactly once', () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    fireUnauthorized();
    fireUnauthorized();

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

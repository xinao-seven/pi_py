import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAuthStatus, listSessions } from '@/lib/api';
import { clearToken, setToken, setUnauthorizedHandler } from '@/lib/session';

function jsonResponse(body: unknown, status: number) {
  // 用普通对象模拟 Response，避免依赖测试环境的全局 Response。
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('api request auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearToken();
    setUnauthorizedHandler(() => {});
  });

  it('attaches Authorization Bearer when a token is present', async () => {
    setToken('t0ken');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessions: [] }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await listSessions();

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');
  });

  it('does not attach Authorization when no token is stored', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessions: [] }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await listSessions();

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('fires the unauthorized handler on 401 with code unauthorized', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: 'unauthorized', message: 'Auth required' } }, 401),
        ),
    );

    await expect(listSessions()).rejects.toThrow('Auth required');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not fire the handler on other errors (e.g. wrong password)', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: 'invalid_password', message: 'Invalid password' } }, 401),
        ),
    );

    await expect(getAuthStatus()).rejects.toThrow('Invalid password');
    expect(handler).not.toHaveBeenCalled();
  });
});

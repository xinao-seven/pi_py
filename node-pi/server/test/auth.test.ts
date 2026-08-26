import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { SessionService } from '../src/services/session-service.js';

describe('访问密码锁', () => {
  const apps: ReturnType<typeof createApp>[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeDistDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pi-auth-dist-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>login test</title>', 'utf8');
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)', 'utf8');
    return dir;
  }

  it('未配置密码时 status 返回 enabled:false 且 API 免登录', async () => {
    const app = createApp();
    apps.push(app);

    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: false });

    const sessions = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(sessions.statusCode).toBe(200);
  });

  it('配置密码后：登录/登出/受保护端点/直接 URL 拦截', async () => {
    const app = createApp({ accessPassword: 's3cret' });
    apps.push(app);

    // 未认证：受保护端点与未匹配 /api 路由均 401（不泄露路由存在性）
    const before = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(before.statusCode).toBe(401);
    expect(before.json()).toMatchObject({ error: { code: 'unauthorized' } });

    const missing = await app.inject({ method: 'GET', url: '/api/nonexistent' });
    expect(missing.statusCode).toBe(401);

    // status：启用、未认证
    const statusBefore = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(statusBefore.json()).toEqual({ enabled: true, authenticated: false });

    // 错误密码 401 invalid_password
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_password' } });

    // 正确密码签发 token
    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 's3cret' },
    });
    expect(good.statusCode).toBe(200);
    const { token } = good.json() as { token: string };
    expect(typeof token).toBe('string');

    // status：已认证
    const statusAfter = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(statusAfter.json()).toEqual({ enabled: true, authenticated: true });

    // Bearer 头可访问受保护端点
    const withHeader = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withHeader.statusCode).toBe(200);

    // 查询参数令牌也可访问（SSE/媒体场景）
    const withQuery = await app.inject({
      method: 'GET',
      url: `/api/sessions?access_token=${token}`,
    });
    expect(withQuery.statusCode).toBe(200);

    // 登出后令牌失效
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('公开端点与健康检查免令牌', async () => {
    const app = createApp({ accessPassword: 's3cret' });
    apps.push(app);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
  });

  it('CORS 预检放行 Authorization 头', async () => {
    const app = createApp({ accessPassword: 's3cret' });
    apps.push(app);

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/sessions',
      headers: {
        origin: 'http://example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    );
  });

  it('启用密码锁时静态页面与 SPA 回退仍公开', async () => {
    const dir = await makeDistDir();
    const app = createApp({ accessPassword: 's3cret', webDistDir: dir });
    apps.push(app);

    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('login test');

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);

    const spa = await app.inject({ method: 'GET', url: '/some/client/route' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('login test');
  });

  it('SessionService 令牌过期后失效', async () => {
    const service = new SessionService(10);
    const token = service.issue();
    expect(service.validate(token)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(service.validate(token)).toBe(false);
  });
});

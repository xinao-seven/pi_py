/**
 * 访问密码登录/状态路由。status 始终存在（未启用时返回 enabled:false），
 * login/logout 仅在启用密码锁时注册，供前端探测密码锁状态。
 *
 * 中文说明：登录时校验密码并签发会话令牌；登出吊销令牌。密码用 SHA-256 摘要
 * 做常数时间比对，启动时已把配置密码哈希一次传入，避免重复哈希与长度泄露。
 */

import type { FastifyPluginAsync } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';

import { ApiError } from '../errors.js';
import type { SessionService } from '../services/session-service.js';

export interface AuthRouteOptions {
  enabled: boolean; // 密码锁是否启用（是否配置了访问密码）
  passwordHash?: Buffer; // 启用时：配置密码的 SHA-256 摘要（app.ts 启动时计算一次）
  sessions: SessionService;
}

/** 从 Authorization 头或 ?access_token= 查询参数提取令牌。 */
function extractToken(request: {
  headers: { authorization?: string };
  query?: unknown;
}): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  if (request.query && typeof request.query === 'object') {
    const queryToken = (request.query as Record<string, unknown>).access_token;
    if (typeof queryToken === 'string') return queryToken;
  }
  return undefined;
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, options) => {
  // GET /api/auth/status —— 前端探测：密码锁是否启用、当前是否已认证。
  app.get('/status', async (request) => {
    if (!options.enabled) return { enabled: false };
    const token = extractToken(request);
    return {
      enabled: true,
      authenticated: token ? options.sessions.validate(token) : false,
    };
  });

  // 未启用密码锁时不暴露 login/logout。
  if (!options.enabled) return;

  // POST /api/auth/login —— 校验密码，正确则签发会话令牌。
  app.post('/login', async (request) => {
    const body = request.body as { password?: unknown } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    const candidate = createHash('sha256').update(password).digest();
    if (!options.passwordHash || !timingSafeEqual(candidate, options.passwordHash)) {
      throw new ApiError(401, 'invalid_password', 'Invalid password');
    }
    return { token: options.sessions.issue() };
  });

  // POST /api/auth/logout —— 吊销当前令牌。
  app.post('/logout', async (request) => {
    const token = extractToken(request);
    if (token) options.sessions.revoke(token);
    return { success: true };
  });
};

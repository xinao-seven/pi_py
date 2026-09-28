/**
 * 访问令牌会话服务（进程内内存）。
 *
 * 中文说明：登录成功后签发随机令牌，后续 /api 请求凭 Authorization:
 * Bearer <token> 或 ?access_token=<token> 通过 onRequest 钩子校验。
 * 令牌只存在内存里：重启即全部失效，需要重新登录（可接受，且符合预期）。
 */

import { randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

export class SessionService {
  private readonly sessions = new Map<string, number>(); // token -> expiresAt(ms)
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** 签发一个新令牌，返回 32 字节随机 hex 串。 */
  issue(): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + this.ttlMs);
    return token;
  }

  /** 校验令牌是否有效（存在且未过期），顺带清理已过期的会话。 */
  validate(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  /** 吊销令牌（登出时调用）。 */
  revoke(token: string): void {
    this.sessions.delete(token);
  }
}

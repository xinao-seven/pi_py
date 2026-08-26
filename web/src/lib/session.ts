// 访问令牌与会话辅助：本模块不依赖 api.ts / store，避免循环依赖。
// 令牌持久化到 localStorage（键 pi.access_token），配合"保持登录"。

const TOKEN_KEY = 'pi.access_token';

export function getToken(): string | undefined {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined; // localStorage 不可用（隐私模式等）
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 隐私模式下无法持久化：令牌只在当前内存会话有效，刷新后需重新登录。
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

// EventSource 与 <img src> 无法携带 Authorization 头，只能把令牌放到查询参数。
// 已有 query（如 /api/files?...type=media）时用 URLSearchParams 合并，避免双 "?"。
export function appendToken(url: string): string {
  const token = getToken();
  if (!token) return url;
  const [base, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('access_token', token);
  return `${base}?${params.toString()}`;
}

let unauthorizedHandler: (() => void) | undefined;

/** 注册全局 401（code=unauthorized）回调；auth store 在启动时调用。 */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

/** request() 遇到鉴权失败时触发，通知 auth store 上锁重新登录。 */
export function fireUnauthorized(): void {
  unauthorizedHandler?.();
}

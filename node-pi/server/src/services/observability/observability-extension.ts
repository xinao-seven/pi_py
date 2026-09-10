/**
 * provider 层观测内联扩展。
 *
 * 中文说明：会话事件流只告诉我们「模型响应用了多久」，无法区分**模型慢**与**网络慢**。
 * 这两个官方钩子补上了 HTTP 层的两个点：
 * - `before_provider_headers`：请求头组装完、发出请求前 → 记录起点；
 * - `after_provider_response`：收到响应、消费流之前 → 拿到 status code，算出发送到首字节的耗时。
 *
 * 扩展本身不做任何决策（不改请求头、不阻断），只把观测点转发给 observer；
 * observer 内部必须自行吞掉异常（见 SessionLedger），保证对 agent loop 零影响。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

/** provider 观测点的接收方（由 SessionLedger 实现）。 */
export interface ProviderObserver {
  /** 一次 provider HTTP 请求即将发出。 */
  noteProviderRequestStart(sessionId: string): void;
  /** 收到 provider 响应（status 非 2xx 时通常是错误响应）。 */
  noteProviderResponse(sessionId: string, status: number): void;
}

/** 从扩展上下文里取会话 id（拿不到就跳过本次观测）。 */
function sessionIdOf(ctx: unknown): string | undefined {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)
    ?.sessionManager;
  try {
    return manager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

/** 生成 provider 层观测扩展。 */
export function buildObservabilityExtension(observer: ProviderObserver): InlineExtension {
  return (pi: ExtensionAPI) => {
    pi.on('before_provider_headers', (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (sessionId) observer.noteProviderRequestStart(sessionId);
    });
    pi.on('after_provider_response', (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (sessionId) observer.noteProviderResponse(sessionId, event.status);
    });
  };
}
